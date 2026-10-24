import { readFile } from "node:fs/promises";

import { asId, type Principal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { H3 } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChannelConnection, ServerChannel } from "../channel.js";
import { createSyncClient } from "../client/sync-client.js";
import type { SyncBatch } from "../protocol.js";
import { SyncHub } from "./hub.js";
import { registerSyncRoutes, type StreamAuthority, transportFromEnv } from "./routes.js";
import { ensureSyncTables, recordSyncEvent } from "./store.js";

let handle: DatabaseHandle;
let app: H3;
let hub: SyncHub;

beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  await ensureSyncTables(handle.db);
  hub = new SyncHub(handle);
  app = new H3();
  registerSyncRoutes(app, {
    basePath: "/_parlor",
    data: handle,
    hub,
    scope: (request) => request.headers.get("x-org") ?? "default",
    audience: (request) => {
      const org = request.headers.get("x-org") ?? "default";
      const user = request.headers.get("x-user");
      return user ? `${org}/${user}` : org;
    },
    keepAliveMs: 50,
  });
}, 30_000);
afterAll(async () => {
  await hub.stop();
  await handle.close();
});

async function readFrames(body: ReadableStream<Uint8Array>, count: number, ms = 2000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;
  while (
    buffer.split("\n\n").filter((f) => f.trim() && !f.startsWith(":")).length < count
  ) {
    if (Date.now() > deadline) break;
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
  }
  await reader.cancel();
  return buffer.split("\n\n").filter((f) => f.trim() && !f.startsWith(":"));
}

describe("sync routes", () => {
  it("negotiates SSE when the provider can push", async () => {
    const response = await app.fetch(
      new Request("http://app.test/_parlor/sync/token", { method: "POST" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      protocol: 1,
      transport: "sse",
      endpoint: "/_parlor/sync/stream",
    });
  });

  it("polls events after a cursor for the request's scope", async () => {
    const first = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "acme", tags: [["tasks", "1"]] }),
    );
    const second = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "acme", tags: [["tasks", "2"]] }),
    );
    const all = await app
      .fetch(
        new Request("http://app.test/_parlor/sync?since=", {
          headers: { "x-org": "acme" },
        }),
      )
      .then((r) => r.json());
    expect(all.events.map((e: { id: string }) => e.id)).toEqual([first.id, second.id]);
    expect(all.cursor).toBe(`${second.version}.${second.id}`);

    const rest = await app
      .fetch(
        new Request(`http://app.test/_parlor/sync?since=${first.version}.${first.id}`, {
          headers: { "x-org": "acme" },
        }),
      )
      .then((r) => r.json());
    expect(rest.events.map((e: { id: string }) => e.id)).toEqual([second.id]);

    const other = await app
      .fetch(
        new Request("http://app.test/_parlor/sync?since=", {
          headers: { "x-org": "other" },
        }),
      )
      .then((r) => r.json());
    expect(other.events).toEqual([]);
  });

  it("adds the caller's own audience to the scope, and never another user's", async () => {
    const shared = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "team", tags: [["tasks", "1"]] }),
    );
    const mine = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "team/alice", tags: [["chat", "a"]] }),
    );
    await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "team/bob", tags: [["chat", "b"]] }),
    );
    const polled = await app
      .fetch(
        new Request("http://app.test/_parlor/sync?since=", {
          headers: { "x-org": "team", "x-user": "alice" },
        }),
      )
      .then((r) => r.json());
    expect(polled.events.map((e: { id: string }) => e.id)).toEqual([shared.id, mine.id]);

    const response = await app.fetch(
      new Request(
        `http://app.test/_parlor/sync/stream?since=${mine.version}.${mine.id}`,
        {
          headers: { "x-org": "team", "x-user": "alice" },
        },
      ),
    );
    const live = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "team/alice", tags: [["chat", "live"]] }),
    );
    await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "team/bob", tags: [["chat", "not-mine"]] }),
    );
    const frames = await readFrames(response.body!, 2);
    expect(frames[1]).toContain(live.id);
    expect(frames.join("")).not.toContain("not-mine");
  });

  it("streams a handshake, missed events, then live events for the scope", async () => {
    const response = await app.fetch(
      new Request("http://app.test/_parlor/sync/stream?since=", {
        headers: { "x-org": "live" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const live = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "live", tags: [["tasks", "9"]] }),
    );
    await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "elsewhere", tags: [["x"]] }),
    );
    const frames = await readFrames(response.body!, 2);
    expect(frames[0]).toContain("event: handshake");
    expect(frames[1]).toContain(live.id);
    expect(frames.join("")).not.toContain('"elsewhere"');
  });

  it("answers a keep-alive stream request with Connection: close so a closing server does not wait on the socket", async () => {
    const response = await app.fetch(
      new Request("http://app.test/_parlor/sync/stream?since=", {
        headers: { connection: "keep-alive" },
      }),
    );
    expect(response.headers.get("connection")).toBe("close");
    await response.body!.cancel();
  });
});

describe("sync stream catch-up", () => {
  it("delivers an event committed after the catch-up query ran but before its result was used", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let queried!: () => void;
    const catchUpQueried = new Promise<void>((resolve) => (queried = resolve));
    const gatedDb = new Proxy(handle.db, {
      get(target, property, receiver) {
        if (property !== "execute") return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          const result = await (
            target.execute as (...a: unknown[]) => Promise<unknown>
          ).apply(target, args);
          queried();
          await gate;
          return result;
        };
      },
    });
    const gated = new H3();
    registerSyncRoutes(gated, {
      basePath: "/_parlor",
      data: { ...handle, read: () => gatedDb },
      hub,
      scope: () => "race",
      keepAliveMs: 50,
    });

    const responsePromise = gated.fetch(
      new Request("http://app.test/_parlor/sync/stream?since="),
    );
    await catchUpQueried;
    const committed = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "race", tags: [["tasks", "raced"]] }),
    );
    await new Promise((r) => setTimeout(r, 50));
    release();

    const response = await responsePromise;
    const frames = await readFrames(response.body!, 2, 1500);
    const delivered = frames
      .filter((f) => f.startsWith("data:"))
      .flatMap((f) => (JSON.parse(f.slice("data:".length)) as SyncBatch).events)
      .filter((e) => e.id === committed.id);
    expect(delivered).toHaveLength(1);
  });
});

describe("transportFromEnv", () => {
  it("accepts only sse or poll", () => {
    expect(transportFromEnv("poll")).toBe("poll");
    expect(transportFromEnv("sse")).toBe("sse");
    expect(transportFromEnv("ws")).toBeUndefined();
    expect(transportFromEnv(undefined)).toBeUndefined();
  });

  it("reads the literal process.env.PARLOR_SYNC_TRANSPORT so a build can bake it", async () => {
    const source = await readFile(new URL("./routes.ts", import.meta.url), "utf8");
    expect(source).toContain("= process.env.PARLOR_SYNC_TRANSPORT");
  });
});

describe("sync stream channels", () => {
  function recordingChannel(event: string) {
    const log: string[] = [];
    let current: ChannelConnection | undefined;
    const channel: ServerChannel = {
      event,
      connect(connection) {
        current = connection;
        log.push(`open ${connection.clientId ?? "-"} ${connection.scope}`);
        connection.send(`hello ${connection.clientId}`);
        return () => log.push("close");
      },
    };
    return { channel, log, send: (data: string) => current?.send(data) };
  }

  function channelApp(...channels: ServerChannel[]) {
    const channelled = new H3();
    registerSyncRoutes(channelled, {
      basePath: "/_parlor",
      data: handle,
      hub,
      scope: () => "channels",
      keepAliveMs: 50,
      channels,
      clientId: (request) => request.headers.get("x-parlor-client") ?? undefined,
    });
    return channelled;
  }

  it("advertises channel events, opens each channel with the client id and scope, and routes its frames", async () => {
    const ui = recordingChannel("ui");
    const response = await channelApp(ui.channel).fetch(
      new Request("http://app.test/_parlor/sync/stream?since=", {
        headers: { "x-parlor-client": "tab-1" },
      }),
    );
    ui.send('{"op":"screen"}');
    const frames = await readFrames(response.body!, 3);
    expect(frames[0]).toBe(
      'event: handshake\ndata: {"protocol":1,"capabilities":["ui"],"keepAliveMs":50}',
    );
    expect(frames.slice(1)).toEqual([
      "event: ui\ndata: hello tab-1",
      'event: ui\ndata: {"op":"screen"}',
    ]);
    expect(ui.log.slice(0, 1)).toEqual(["open tab-1 channels"]);
  });

  it("closes each channel exactly once when the stream closes", async () => {
    const ui = recordingChannel("ui");
    const response = await channelApp(ui.channel).fetch(
      new Request("http://app.test/_parlor/sync/stream?since="),
    );
    await readFrames(response.body!, 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(ui.log).toEqual(["open - channels", "close"]);
  });

  it("advertises no capabilities without channels", async () => {
    const response = await channelApp().fetch(
      new Request("http://app.test/_parlor/sync/stream?since="),
    );
    const frames = await readFrames(response.body!, 1);
    expect(frames[0]).toBe(
      'event: handshake\ndata: {"protocol":1,"capabilities":[],"keepAliveMs":50}',
    );
  });

  it("delivers server channel frames to the matching client channel end to end", async () => {
    const ui = recordingChannel("ui");
    const server = channelApp(ui.channel);
    const received: string[] = [];
    const lifecycle: string[] = [];
    const client = createSyncClient({
      request: (path, init) => {
        const headers = new Headers(init?.headers);
        headers.set("x-parlor-client", "tab-2");
        return server.fetch(new Request(`http://app.test${path}`, { ...init, headers }));
      },
      clientId: "tab-2",
      onEvents: () => {},
      channels: [
        {
          event: "ui",
          opened: () => lifecycle.push("opened"),
          receive: (data) => received.push(data),
          closed: () => lifecycle.push("closed"),
        },
      ],
    });
    client.start();
    await vi.waitFor(() => expect(received).toEqual(["hello tab-2"]));
    ui.send("second");
    await vi.waitFor(() => expect(received).toEqual(["hello tab-2", "second"]));
    client.stop();
    await vi.waitFor(() => expect(lifecycle).toEqual(["opened", "closed"]));
    await vi.waitFor(() => expect(ui.log.at(-1)).toBe("close"));
  });
});

describe("sync stream channel connections", () => {
  const principalOf = (userId: string): Principal => ({
    kind: "user",
    userId: asId("user", userId),
    sessionId: `session-${userId}`,
  });

  function ownerChannel(event: string) {
    const log: string[] = [];
    const sends = new Map<string, (data: string) => void>();
    const closedSignals: AbortSignal[] = [];
    const channel: ServerChannel = {
      event,
      connect(connection) {
        const owner =
          connection.principal?.kind === "user" ? connection.principal.userId : "-";
        log.push(`open ${owner}`);
        sends.set(owner, connection.send);
        if (connection.closed) closedSignals.push(connection.closed);
        connection.closed?.addEventListener("abort", () => log.push(`aborted ${owner}`));
        return () => log.push(`close ${owner}`);
      },
    };
    return { channel, log, sends, closedSignals };
  }

  function appFor(
    chat: ServerChannel,
    authority: (request: Request) => Promise<StreamAuthority>,
  ) {
    const channelled = new H3();
    registerSyncRoutes(channelled, {
      basePath: "/_parlor",
      data: handle,
      hub,
      scope: () => "channels",
      keepAliveMs: 50,
      channels: [chat],
      authority,
    });
    return channelled;
  }

  const as = (userId: string) =>
    new Request("http://app.test/_parlor/sync/stream?since=", {
      headers: { "x-user": userId },
    });

  it("hands each stream its own holder, so a channel can send to its owner alone", async () => {
    const chat = ownerChannel("chat");
    const server = appFor(chat.channel, async (request) => ({
      principal: principalOf(request.headers.get("x-user")!),
      channels: true,
    }));
    const alice = await server.fetch(as("alice"));
    const bob = await server.fetch(as("bob"));
    chat.sends.get("alice")!("for-alice");

    expect(await readFrames(alice.body!, 2)).toEqual([
      'event: handshake\ndata: {"protocol":1,"capabilities":["chat"],"keepAliveMs":50}',
      "event: chat\ndata: for-alice",
    ]);
    expect(await readFrames(bob.body!, 1, 200)).toEqual([
      'event: handshake\ndata: {"protocol":1,"capabilities":["chat"],"keepAliveMs":50}',
    ]);
  });

  it("aborts the connection's closed signal when the stream ends, before the channel detaches", async () => {
    const chat = ownerChannel("chat");
    const server = appFor(chat.channel, async () => ({
      principal: principalOf("alice"),
      channels: true,
    }));
    const response = await server.fetch(as("alice"));
    await readFrames(response.body!, 1);

    await vi.waitFor(() =>
      expect(chat.log).toEqual(["open alice", "aborted alice", "close alice"]),
    );
    expect(chat.closedSignals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("aborts the closed signal when the holder's credential is revoked", async () => {
    const chat = ownerChannel("chat");
    const revocation = new AbortController();
    const server = appFor(chat.channel, async () => ({
      principal: principalOf("alice"),
      channels: true,
      revoked: revocation.signal,
    }));
    const response = await server.fetch(as("alice"));
    const reader = response.body!.getReader();
    await reader.read();
    expect(chat.closedSignals.map((signal) => signal.aborted)).toEqual([false]);

    revocation.abort();
    await vi.waitFor(() =>
      expect(chat.closedSignals.map((s) => s.aborted)).toEqual([true]),
    );
    await reader.cancel();
  });
});
