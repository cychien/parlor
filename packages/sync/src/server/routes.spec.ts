import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { H3 } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SyncBatch } from "../protocol.js";
import { SyncHub } from "./hub.js";
import { registerSyncRoutes } from "./routes.js";
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
    keepAliveMs: 50,
  });
});
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
  it("accepts only sse or poll", async () => {
    const { transportFromEnv } = await import("./routes.js");
    expect(transportFromEnv({ PARLOR_SYNC_TRANSPORT: "poll" })).toBe("poll");
    expect(transportFromEnv({ PARLOR_SYNC_TRANSPORT: "sse" })).toBe("sse");
    expect(transportFromEnv({ PARLOR_SYNC_TRANSPORT: "ws" })).toBeUndefined();
    expect(transportFromEnv({})).toBeUndefined();
  });
});
