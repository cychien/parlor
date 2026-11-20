import { asId, type DataProvider, type Principal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { H3 } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelConnection, ServerChannel } from "../channel.js";
import { SyncHub } from "./hub.js";
import { registerSyncRoutes } from "./routes.js";
import type {
  HostedSocket,
  RestoredSocket,
  SocketPlatform,
  SyncSockets,
} from "./sockets.js";
import { ensureSyncTables, recordSyncEvent } from "./store.js";

/** A socket as the platform hands it to one instance; another instance gets another object. */
class FakeSocket implements HostedSocket {
  closedWith: { code?: number; reason?: string } | undefined;
  answeredAt: number | undefined;
  constructor(readonly line: { sent: string[]; attachment: unknown; closed: boolean }) {}
  get attachment() {
    return this.line.attachment;
  }
  attach(value: unknown) {
    this.line.attachment = value;
  }
  send(data: string) {
    if (!this.line.closed) this.line.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.line.closed = true;
  }
}

/** One Durable Object instance: it sees the lines its predecessor accepted as new objects. */
function instance(lines: { sent: string[]; attachment: unknown; closed: boolean }[]) {
  const sockets = new Map<object, FakeSocket>();
  const wakes: number[] = [];
  const of = (line: (typeof lines)[number]) => {
    let socket = sockets.get(line);
    if (!socket) sockets.set(line, (socket = new FakeSocket(line)));
    return socket;
  };
  const platform: SocketPlatform = {
    accept(_request, attachment) {
      const line = { sent: [] as string[], attachment, closed: false };
      lines.push(line);
      return { response: new Response("upgraded"), socket: of(line) };
    },
    sockets: () => lines.filter((line) => !line.closed).map(of),
    wakeAt: (at) => {
      wakes.push(at);
    },
  };
  return { platform, of, wakes };
}

const frames = (line: { sent: string[] }) =>
  line.sent.map((text) => JSON.parse(text) as { event: string; data: string });
const events = (line: { sent: string[] }) =>
  frames(line)
    .filter((frame) => frame.event === "message")
    .flatMap(
      (frame) => (JSON.parse(frame.data) as { events: { tags: unknown }[] }).events,
    );

const alice: Principal = {
  kind: "user",
  userId: asId("user", "alice"),
  sessionId: "s-1",
};
const mac: Principal = {
  kind: "host",
  userId: asId("user", "alice"),
  grantId: asId("grant", "g-mac"),
  hostId: asId("host", "mac"),
};

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  await ensureSyncTables(handle.db);
}, 30_000);
afterAll(() => handle.close());

describe("sync over sockets the platform holds while the server sleeps", () => {
  let app: H3;
  let sockets: SyncSockets;
  let hubs: SyncHub[];
  let joined: ChannelConnection[];
  let left: ChannelConnection[];
  let restored: RestoredSocket[];
  let revocations: Map<string, AbortController>;
  let now: number;

  const channel: ServerChannel = {
    event: "chat",
    hosts: true,
    connect(connection) {
      joined.push(connection);
      return () => left.push(connection);
    },
  };

  beforeEach(() => {
    joined = [];
    left = [];
    restored = [];
    revocations = new Map();
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    hubs = [];
    sockets = serve();
    return async () => {
      vi.restoreAllMocks();
      for (const one of hubs) await one.stop();
    };
  });

  /** One server process: its own hub and routes, and so its own memory of the sockets. */
  const serve = (data: DataProvider = handle) => {
    const hub = new SyncHub(data);
    hubs.push(hub);
    app = new H3();
    return registerSyncRoutes(app, {
      basePath: "/_parlor",
      data,
      hub,
      scope: () => "acme",
      audience: (request) => `acme/${request.headers.get("x-user") ?? "alice"}`,
      clientId: (request) => request.headers.get("x-parlor-client") ?? undefined,
      authority: async (request) => ({
        principal: request.headers.get("x-user") === "mac" ? mac : alice,
        channels: true,
      }),
      revokedOf: (principal) => {
        const key = principal.kind === "user" ? principal.sessionId : "host";
        let controller = revocations.get(key);
        if (!controller) revocations.set(key, (controller = new AbortController()));
        return controller.signal;
      },
      restored: (socket) => restored.push(socket),
      channels: [channel],
      pingMs: 1000,
    }).sockets;
  };

  const request = (path: string, init: RequestInit & { user?: string } = {}) =>
    Promise.resolve(
      app.fetch(
        new Request(`http://app.test${path}`, {
          ...init,
          headers: {
            "x-parlor-client": init.user === "mac" ? "computer" : "tab-1",
            ...(init.user ? { "x-user": init.user } : {}),
            ...(init.headers as object),
          },
        }),
      ),
    );
  const negotiate = async (user?: string, offer = "?transports=ws") =>
    (await (
      await request(`/_parlor/sync/token${offer}`, {
        method: "POST",
        ...(user ? { user } : {}),
      })
    ).json()) as { transport: string; endpoint: string; ticket?: string };
  const open = (ticket: string, since = "") =>
    sockets.open(
      new Request(`http://app.test/_parlor/sync/socket?ticket=${ticket}&since=${since}`, {
        headers: { upgrade: "websocket" },
      }),
    );
  const write = (scope: string, id: string) =>
    handle.transaction((tx) =>
      recordSyncEvent(
        tx,
        { scope, tags: [["notes", id]] },
        async (channelName, payload, t) => handle.notify(channelName, payload, t),
      ),
    );

  it("offers sockets only to a client that offers them, once a platform holds them", async () => {
    expect((await negotiate()).transport).toBe("sse");
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    expect((await negotiate(undefined, "")).transport).toBe("sse");
    const offered = await negotiate();
    expect(offered).toMatchObject({ transport: "ws", endpoint: "/_parlor/sync/socket" });
    expect(offered.ticket).toMatch(/^[0-9a-f]{64}$/);
  });

  it("catches a socket wired again on a bus up on what others wrote while it slept, without greeting it again", async () => {
    // A Durable Object's memory goes when it sleeps: its hub stops hearing, its sockets stay open.
    let asleep = false;
    const onBus = (): DataProvider => ({
      ...handle,
      notifications: "bus",
      listen: (name, handler, options) =>
        handle.listen(name, (payload) => asleep || handler(payload), options),
    });
    sockets = serve(onBus());
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    const { ticket } = await negotiate();
    await open(ticket!);
    const [line] = lines;
    await write("acme", "seen");
    await vi.waitFor(() =>
      expect(events(line!).at(-1)!.tags).toEqual([["notes", "seen"]]),
    );
    expect(line!.attachment).toHaveProperty("cursor");

    asleep = true;
    await write("acme", "while asleep");

    sockets = serve({ ...handle, notifications: "bus" });
    sockets.install(instance(lines).platform);
    await sockets.ensure();
    await vi.waitFor(() =>
      expect(events(line!).map((event) => event.tags)).toContainEqual([
        ["notes", "while asleep"],
      ]),
    );
    expect(frames(line!).filter((frame) => frame.event === "handshake")).toHaveLength(1);
    expect(
      events(line!).filter((event) => JSON.stringify(event.tags).includes("seen")),
    ).toHaveLength(1);
  });

  it("greets a socket opened with a ticket, sends what it missed, then what is written", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    const first = instance(lines);
    sockets.install(first.platform);
    const missed = await write("acme", "before");
    const { ticket } = await negotiate();
    expect(await (await open(ticket!)).text()).toBe("upgraded");
    const [line] = lines;
    const [greeting] = frames(line!);
    expect(greeting!.event).toBe("handshake");
    expect(JSON.parse(greeting!.data)).toMatchObject({
      protocol: 1,
      capabilities: ["chat"],
      presence: true,
      pingMs: 1000,
    });
    await vi.waitFor(() =>
      expect(events(line!).map((event) => event.tags)).toContainEqual([
        ["notes", "before"],
      ]),
    );
    expect(missed.id).toBeTruthy();
    await write("acme", "after");
    await vi.waitFor(() =>
      expect(events(line!).at(-1)!.tags).toEqual([["notes", "after"]]),
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ clientId: "tab-1", scope: "acme", watched: true });
    expect(first.wakes).toEqual([now + 2500]);
  });

  it("spends a ticket once, and refuses one that is unknown or old", async () => {
    sockets.install(instance([]).platform);
    const { ticket } = await negotiate();
    expect((await open(ticket!)).status).toBe(200);
    expect((await open(ticket!)).status).toBe(401);
    expect((await open("made-up")).status).toBe(401);
    const { ticket: late } = await negotiate();
    now += 30_001;
    expect((await open(late!)).status).toBe(401);
  });

  it("keeps its wiring when the next instance in the same process hands the sockets over", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    await open((await negotiate()).ticket!);
    await open((await negotiate("mac")).ticket!);

    sockets.install(instance(lines).platform);
    await sockets.ensure();
    expect(left).toEqual([]);
    expect(joined).toHaveLength(2);
    await write("acme", "woken");
    await vi.waitFor(() =>
      expect(lines.map((line) => events(line).at(-1)?.tags)).toEqual([
        [["notes", "woken"]],
        [["notes", "woken"]],
      ]),
    );
  });

  it("lets nobody leave on an alarm in the next instance while the sockets answer", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    await open((await negotiate("mac")).ticket!);
    const woken = instance(lines);
    sockets.install(woken.platform);
    now += 2000;
    woken.of(lines[0]!).answeredAt = now - 500;
    await sockets.alarm();
    expect(left).toEqual([]);
    expect(lines[0]!.closed).toBe(false);
    expect(woken.wakes).toEqual([now - 500 + 2500]);
  });

  it("wires the sockets again in a process that lost its memory, without greeting them twice", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    await open((await negotiate()).ticket!);
    await open((await negotiate("mac")).ticket!);

    const cold = serve();
    cold.install(instance(lines).platform);
    await cold.ensure();
    await cold.ensure();
    expect(joined).toHaveLength(4);
    expect(
      lines.map((line) => frames(line).filter((f) => f.event === "handshake").length),
    ).toEqual([1, 1]);
    await write("acme", "woken");
    await vi.waitFor(() =>
      expect(lines.map((line) => events(line).at(-1)?.tags)).toEqual([
        [["notes", "woken"]],
        [["notes", "woken"]],
      ]),
    );
  });

  it("hands what it remembered of a client back once a cold process wires its sockets", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    await open((await negotiate()).ticket!);
    const presence = { type: "presence", focused: true, visible: true, platform: "web" };
    sockets.remember("tab-1", presence);
    sockets.remember("somebody else", { type: "presence" });
    const cold = serve();
    cold.install(instance(lines).platform);
    await cold.ensure();
    expect(restored).toEqual([
      { clientId: "tab-1", audience: "acme/alice", remembered: presence },
    ]);
  });

  it("closes a socket whose credential is revoked, also after a cold start", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    await open((await negotiate()).ticket!);
    const cold = serve();
    cold.install(instance(lines).platform);
    await cold.ensure();
    revocations.get("s-1")!.abort();
    expect(lines[0]!.closed).toBe(true);
  });

  it("tells the channels a computer left when its socket closes, also after a cold start, and not for a tab", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    sockets.install(instance(lines).platform);
    await open((await negotiate()).ticket!);
    await open((await negotiate("mac")).ticket!);
    const cold = serve();
    const asleep = instance(lines);
    cold.install(asleep.platform);
    left.length = 0;
    joined.length = 0;

    lines[0]!.closed = true;
    await cold.closed(asleep.of(lines[0]!));
    expect(joined).toEqual([]);

    lines[1]!.closed = true;
    await cold.closed(asleep.of(lines[1]!));
    await cold.closed(asleep.of(lines[1]!));
    expect(left.map((connection) => connection.principal?.kind)).toEqual(["host"]);
  });

  it("closes the sockets whose pings went unanswered and asks to wake for the next one due", async () => {
    const lines: { sent: string[]; attachment: unknown; closed: boolean }[] = [];
    const awake = instance(lines);
    sockets.install(awake.platform);
    await open((await negotiate()).ticket!);
    now += 1000;
    await open((await negotiate("mac")).ticket!);
    awake.of(lines[1]!).answeredAt = now + 1500;
    now += 2000;
    await sockets.alarm();
    expect(lines.map((line) => line.closed)).toEqual([true, false]);
    expect(awake.wakes.at(-1)).toBe(1_005_000);
    expect(left.map((connection) => connection.principal?.kind)).toEqual(["user"]);
  });
});
