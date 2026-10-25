import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSyncClient, SyncRequestTimeout, SyncUnauthorized } from "./sync-client.js";

function sseBody(frames: string[], { end = false } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (end) controller.close();
    },
  });
}

const event = (version: number, id: string, source?: string) => ({
  version,
  id,
  tags: [["tasks", id]],
  ...(source ? { source } : {}),
});

describe("createSyncClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("negotiates, polls after the cursor, dedupes, and skips its own events", async () => {
    const calls: string[] = [];
    let batchNo = 0;
    const request = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs: 100,
        });
      }
      batchNo += 1;
      const events =
        batchNo === 1
          ? [event(1, "a"), event(2, "b", "me")]
          : batchNo === 2
            ? [event(2, "b", "me"), event(3, "c")]
            : [];
      const last = events.at(-1);
      return Response.json({ events, cursor: last ? `${last.version}.${last.id}` : "" });
    });
    const onEvents = vi.fn();
    const client = createSyncClient({
      request,
      onEvents,
      clientId: "me",
      coalesceMs: 10,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.transport).toBe("poll");
    await vi.advanceTimersByTimeAsync(20);
    expect(onEvents).toHaveBeenCalledWith([event(1, "a")]);
    expect(client.cursor).toBe("2.b");

    await vi.advanceTimersByTimeAsync(120);
    expect(onEvents).toHaveBeenLastCalledWith([event(3, "c")]);
    expect(calls.at(-1)).toContain("since=2.b");

    client.stop();
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(request.mock.calls.length).toBe(count);
  });

  it("consumes SSE frames and coalesces bursts into one delivery", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        return new Response(
          sseBody([
            'event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n',
            `data: ${JSON.stringify({ events: [event(5, "x")], cursor: "5.x" })}\n\n`,
            `data: ${JSON.stringify({ events: [event(6, "y")], cursor: "6.y" })}\n\n`,
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    const onEvents = vi.fn();
    const client = createSyncClient({ request, onEvents, coalesceMs: 50 });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.transport).toBe("sse");
    await vi.advanceTimersByTimeAsync(60);
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents).toHaveBeenCalledWith([event(5, "x"), event(6, "y")]);
    expect(client.cursor).toBe("6.y");
    client.stop();
  });

  it("starts where the page's data stands until it has a cursor of its own", async () => {
    const streams: string[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      streams.push(path);
      const frames = ['event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n'];
      if (streams.length === 2) {
        frames.push(
          `data: ${JSON.stringify({ events: [event(9, "z")], cursor: "9.z" })}\n\n`,
        );
      }
      return new Response(sseBody(frames, { end: streams.length < 3 }), { status: 200 });
    });
    let held = "7.h";
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      startAt: () => held,
      reconnectBaseMs: 100,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(streams[0]).toContain(`since=${encodeURIComponent("7.h")}`);
    expect(client.cursor).toBe("");

    held = "8.i";
    await vi.advanceTimersByTimeAsync(150);
    expect(streams[1]).toContain(`since=${encodeURIComponent("8.i")}`);
    await vi.advanceTimersByTimeAsync(300);
    expect(client.cursor).toBe("9.z");
    expect(streams[2]).toContain(`since=${encodeURIComponent("9.z")}`);
    client.stop();
  });

  it("asks for resets only with onReset, and continues from the cursor a reset names", async () => {
    const polls: string[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs: 100,
        });
      }
      polls.push(path);
      return polls.length === 1
        ? Response.json({ events: [], cursor: "40.r", reset: true })
        : Response.json({ events: [event(41, "s")], cursor: "41.s" });
    });
    const onEvents = vi.fn();
    const onReset = vi.fn();
    const client = createSyncClient({
      request,
      onEvents,
      onReset,
      startAt: () => "7.h",
      coalesceMs: 10,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls[0]).toBe(`/_parlor/sync?since=${encodeURIComponent("7.h")}&reset=1`);
    expect(onReset).toHaveBeenCalledWith("40.r");
    expect(client.cursor).toBe("40.r");
    expect(onEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    expect(polls[1]).toBe(`/_parlor/sync?since=${encodeURIComponent("40.r")}&reset=1`);
    expect(onEvents).toHaveBeenCalledWith([event(41, "s")]);
    client.stop();

    polls.length = 0;
    const unaware = createSyncClient({ request, onEvents: vi.fn() });
    unaware.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls[0]).toBe("/_parlor/sync?since=");
    unaware.stop();
  });

  it("falls back to polling when negotiation fails", async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith("/sync/token")
        ? new Response("nope", { status: 500 })
        : Response.json({ events: [], cursor: "" }),
    );
    const onError = vi.fn();
    const client = createSyncClient({ request, onEvents: vi.fn(), onError });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2100);
    expect(request.mock.calls.some(([p]) => String(p).includes("/sync?since="))).toBe(
      true,
    );
    client.stop();
  });
});

describe("createSyncClient negotiation retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function serverComingUp(failures: number) {
    const tokenAttempts: number[] = [];
    const streams: string[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        tokenAttempts.push(Date.now());
        if (tokenAttempts.length <= failures)
          return new Response("down", { status: 502 });
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        streams.push(path);
        return new Response(
          sseBody(['event: handshake\ndata: {"protocol":1,"capabilities":["ui"]}\n\n']),
          { status: 200 },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    return { request, tokenAttempts, streams };
  }

  const channel = () => {
    const log: string[] = [];
    return {
      log,
      channel: {
        event: "ui",
        opened: () => log.push("opened"),
        receive: () => {},
        closed: () => log.push("closed"),
      },
    };
  };

  it("keeps negotiating with backoff while the server is down and polls in the meantime", async () => {
    const { request, tokenAttempts, streams } = serverComingUp(Number.POSITIVE_INFINITY);
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      reconnectBaseMs: 1000,
      reconnectMaxMs: 4000,
    });
    const t0 = Date.now();
    client.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(tokenAttempts.map((at) => at - t0)).toEqual([
      0, 1000, 3000, 7000, 11_000, 15_000, 19_000,
    ]);
    expect(streams).toEqual([]);
    expect(client.transport).toBe("poll");
    expect(
      request.mock.calls.filter(([p]) => String(p).includes("/sync?since=")),
    ).not.toHaveLength(0);
    client.stop();
  });

  it("joins SSE and opens its channels once the server starts answering", async () => {
    const { request, streams } = serverComingUp(2);
    const ui = channel();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      reconnectBaseMs: 1000,
      channels: [ui.channel],
    });
    client.start();
    await vi.advanceTimersByTimeAsync(2900);
    expect(ui.log).toEqual([]);
    expect(client.transport).toBe("poll");

    await vi.advanceTimersByTimeAsync(200);
    expect(streams).toHaveLength(1);
    expect(ui.log[0]).toBe("opened");
    expect(client.transport).toBe("sse");
    client.stop();
  });

  it("leaves fast polling for the safety poll after it joins SSE", async () => {
    const { request } = serverComingUp(1);
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      reconnectBaseMs: 1000,
      safetyPollMs: 60_000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(client.transport).toBe("sse");
    const polls = () =>
      request.mock.calls.filter(([p]) => String(p).includes("/sync?since=")).length;
    const before = polls();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls()).toBe(before);
    client.stop();
  });
});

describe("createSyncClient refused credentials", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a 401 and keeps negotiating instead of polling with a dead credential", async () => {
    let signedIn = false;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        if (!signedIn) return new Response(null, { status: 401 });
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        return new Response(
          sseBody(['event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n']),
          { status: 200 },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    const onUnauthorized = vi.fn();
    const onError = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError,
      onUnauthorized,
      reconnectBaseMs: 1000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onUnauthorized).toHaveBeenCalled();
    expect(onUnauthorized.mock.calls[0]![0]).toBeInstanceOf(SyncUnauthorized);
    expect(onError).not.toHaveBeenCalled();
    expect(client.transport).toBeUndefined();
    expect(
      request.mock.calls.filter(([p]) => String(p).includes("/sync?since=")),
    ).toHaveLength(0);

    signedIn = true;
    await vi.advanceTimersByTimeAsync(8000);
    expect(client.transport).toBe("sse");
    client.stop();
  });

  it("stops a poll-only client from polling once its credential is refused", async () => {
    let refused = false;
    const request = vi.fn(async (path: string) => {
      if (refused) return new Response(null, { status: 401 });
      if (path.endsWith("/sync/token"))
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs: 100,
        });
      return Response.json({ events: [], cursor: "" });
    });
    const onUnauthorized = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onUnauthorized,
      reconnectBaseMs: 1000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(client.transport).toBe("poll");

    refused = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const polls = () =>
      request.mock.calls.filter(([p]) => String(p).includes("/sync?since=")).length;
    const after = polls();
    await vi.advanceTimersByTimeAsync(500);
    expect(polls()).toBe(after);
    client.stop();
  });
});

describe("createSyncClient channels", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const negotiation = Response.json.bind(Response, {
    protocol: 1,
    transport: "sse",
    endpoint: "/_parlor/sync/stream",
    pollIntervalMs: 2000,
  });

  function recorder(name: string, receive?: (data: string) => void) {
    const log: string[] = [];
    return {
      log,
      channel: {
        event: name,
        opened: () => log.push("opened"),
        receive: (data: string) => {
          log.push(`receive ${data}`);
          receive?.(data);
        },
        closed: () => log.push("closed"),
      },
    };
  }

  function streamOf(...bodies: string[][]) {
    let n = 0;
    return vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) return negotiation();
      if (path.includes("/sync/stream")) {
        const frames = bodies[Math.min(n, bodies.length - 1)]!;
        n += 1;
        return new Response(sseBody(frames, { end: true }), { status: 200 });
      }
      return Response.json({ events: [], cursor: "" });
    });
  }

  it("opens advertised channels, routes their frames, and closes them when the stream ends", async () => {
    const ui = recorder("ui");
    const other = recorder("other");
    const request = streamOf([
      'event: handshake\ndata: {"protocol":1,"capabilities":["ui"]}\n\n',
      "event: ui\ndata: first\n\n",
      "event: other\ndata: ignored\n\n",
      "event: ui\ndata: second\n\n",
    ]);
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      channels: [ui.channel, other.channel],
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.log).toEqual(["opened", "receive first", "receive second", "closed"]);
    expect(other.log).toEqual([]);
    client.stop();
  });

  it("keeps the stream alive when a channel throws", async () => {
    const onError = vi.fn();
    const onEvents = vi.fn();
    const ui = recorder("ui", () => {
      throw new Error("bad frame");
    });
    const request = streamOf([
      'event: handshake\ndata: {"protocol":1,"capabilities":["ui"]}\n\n',
      "event: ui\ndata: boom\n\n",
      `data: ${JSON.stringify({ events: [event(7, "z")], cursor: "7.z" })}\n\n`,
    ]);
    const client = createSyncClient({
      request,
      onEvents,
      onError,
      coalesceMs: 10,
      channels: [ui.channel],
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledWith(new Error("bad frame"));
    expect(onEvents).toHaveBeenCalledWith([event(7, "z")]);
    expect(client.cursor).toBe("7.z");
    client.stop();
  });

  it("opens the channel again after every reconnect", async () => {
    const ui = recorder("ui");
    const request = streamOf([
      'event: handshake\ndata: {"protocol":1,"capabilities":["ui"]}\n\n',
    ]);
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      reconnectBaseMs: 100,
      channels: [ui.channel],
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(ui.log).toEqual(["opened", "closed", "opened", "closed"]);
    client.stop();
  });
});

describe("createSyncClient stream liveness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const encoder = new TextEncoder();
  const handshake = (keepAliveMs?: number) =>
    `event: handshake\ndata: ${JSON.stringify({
      protocol: 1,
      capabilities: ["ui"],
      ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
    })}\n\n`;

  function openStreams(firstFrame: string) {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
              controller.enqueue(encoder.encode(firstFrame));
            },
          }),
          { status: 200 },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    const streams = () =>
      request.mock.calls.filter(([path]) => String(path).includes("/sync/stream")).length;
    return { request, controllers, streams };
  }

  function recorded() {
    const log: string[] = [];
    return {
      log,
      channel: {
        event: "ui",
        opened: () => log.push("opened"),
        receive: () => {},
        closed: () => log.push("closed"),
      },
    };
  }

  async function started(firstFrame: string) {
    const ui = recorded();
    const open = openStreams(firstFrame);
    const client = createSyncClient({
      request: open.request,
      onEvents: vi.fn(),
      channels: [ui.channel],
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    return { ...open, ui, client };
  }

  it("reconnects and reopens its channels when the stream goes silent", async () => {
    const { ui, streams, client } = await started(handshake(10_000));
    expect(ui.log).toEqual(["opened"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ui.log).toEqual(["opened"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ui.log).toEqual(["opened", "closed", "opened"]);
    expect(streams()).toBe(2);
    client.stop();
  });

  it("stays on one stream while the server keeps sending comments, and leaves it once they stop", async () => {
    const { ui, streams, controllers, client } = await started(handshake(10_000));
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      controllers[0]!.enqueue(encoder.encode(": keep-alive\n\n"));
    }
    expect(ui.log).toEqual(["opened"]);
    expect(streams()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ui.log).toEqual(["opened", "closed", "opened"]);
    expect(streams()).toBe(2);
    client.stop();
  });

  it("assumes the 25 s keep-alive of older servers when the handshake does not advertise one", async () => {
    const { ui, streams, controllers, client } = await started(handshake());
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      controllers[0]!.enqueue(encoder.encode(": keep-alive\n\n"));
    }
    expect(ui.log).toEqual(["opened"]);
    expect(streams()).toBe(1);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(ui.log).toEqual(["opened", "closed", "opened"]);
    expect(streams()).toBe(2);
    client.stop();
  });

  it("derives the silence window from the keep-alive the server advertises", async () => {
    const { ui, client } = await started(handshake(1000));
    await vi.advanceTimersByTimeAsync(6000);
    expect(ui.log).toEqual(["opened"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ui.log).toEqual(["opened", "closed", "opened"]);
    client.stop();
  });

  it("does not report a silent stream as an error", async () => {
    const onError = vi.fn();
    const open = openStreams(handshake(10_000));
    const client = createSyncClient({
      request: open.request,
      onEvents: vi.fn(),
      onError,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(open.streams()).toBeGreaterThan(1);
    expect(onError).not.toHaveBeenCalled();
    client.stop();
  });
});

describe("createSyncClient addChannel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function openStream() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      body,
      push: (text: string) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
  }

  function server(capabilities: string[]) {
    const streams: ReturnType<typeof openStream>[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        const live = openStream();
        streams.push(live);
        live.push(
          `event: handshake\ndata: ${JSON.stringify({ protocol: 1, capabilities })}\n\n`,
        );
        return new Response(live.body, { status: 200 });
      }
      return Response.json({ events: [], cursor: "" });
    });
    return { request, streams };
  }

  function recorder(name: string) {
    const log: string[] = [];
    return {
      log,
      channel: {
        event: name,
        opened: () => log.push("opened"),
        receive: (data: string) => log.push(`receive ${data}`),
        closed: () => log.push("closed"),
      },
    };
  }

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };

  it("opens a channel added after the stream started when the handshake listed it, then routes its frames", async () => {
    const { request, streams } = server(["ui", "chat"]);
    const chat = recorder("chat");
    const client = createSyncClient({ request, onEvents: vi.fn() });
    client.start();
    await settle();

    client.addChannel(chat.channel);
    expect(chat.log).toEqual(["opened"]);
    streams[0]!.push("event: chat\ndata: delta-1\n\n");
    await settle();
    expect(chat.log).toEqual(["opened", "receive delta-1"]);
    client.stop();
  });

  it("opens a channel added before the handshake arrives once the handshake lists it", async () => {
    const { request } = server(["chat"]);
    const chat = recorder("chat");
    const client = createSyncClient({ request, onEvents: vi.fn() });
    client.start();
    client.addChannel(chat.channel);
    expect(chat.log).toEqual([]);
    await settle();
    expect(chat.log).toEqual(["opened"]);
    client.stop();
  });

  it("never opens a channel the server did not list, and does not throw", async () => {
    const { request, streams } = server(["ui"]);
    const chat = recorder("chat");
    const onError = vi.fn();
    const client = createSyncClient({ request, onEvents: vi.fn(), onError });
    client.start();
    await settle();

    expect(() => client.addChannel(chat.channel)).not.toThrow();
    streams[0]!.push("event: chat\ndata: stray\n\n");
    await settle();
    expect(chat.log).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    client.stop();
  });

  it("closes the channel on detach and ignores its later frames", async () => {
    const { request, streams } = server(["chat"]);
    const chat = recorder("chat");
    const client = createSyncClient({ request, onEvents: vi.fn() });
    client.start();
    await settle();
    const detach = client.addChannel(chat.channel);

    detach();
    streams[0]!.push("event: chat\ndata: late\n\n");
    await settle();
    expect(chat.log).toEqual(["opened", "closed"]);
    client.stop();
  });

  it("reopens the channel on the next stream without losing a sync event", async () => {
    const { request, streams } = server(["chat"]);
    const chat = recorder("chat");
    const onEvents = vi.fn();
    const client = createSyncClient({
      request,
      onEvents,
      reconnectBaseMs: 100,
      coalesceMs: 10,
    });
    client.start();
    await settle();
    client.addChannel(chat.channel);

    streams[0]!.push(
      `data: ${JSON.stringify({ events: [event(1, "a")], cursor: "1.a" })}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(20);
    streams[0]!.end();
    await vi.advanceTimersByTimeAsync(150);
    streams[1]!.push(
      `data: ${JSON.stringify({ events: [event(2, "b")], cursor: "2.b" })}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(chat.log).toEqual(["opened", "closed", "opened"]);
    expect(onEvents.mock.calls).toEqual([[[event(1, "a")]], [[event(2, "b")]]]);
    expect(request.mock.calls.map(([path]) => String(path)).at(-1)).toContain(
      "since=1.a",
    );
    client.stop();
  });

  it("replaces a channel registered for the same event, closing the old one", async () => {
    const { request } = server(["chat"]);
    const first = recorder("chat");
    const second = recorder("chat");
    const client = createSyncClient({ request, onEvents: vi.fn() });
    client.start();
    await settle();

    client.addChannel(first.channel);
    client.addChannel(second.channel);
    expect(first.log).toEqual(["opened", "closed"]);
    expect(second.log).toEqual(["opened"]);
    client.stop();
  });
});

describe("createSyncClient reconnectNow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sse = {
    protocol: 1,
    transport: "sse",
    endpoint: "/_parlor/sync/stream",
    pollIntervalMs: 2000,
  };
  const poll = { protocol: 1, transport: "poll", endpoint: "", pollIntervalMs: 2000 };
  const isPoll = (path: unknown) => String(path).includes("/sync?since=");

  it("ends a backoff wait at once, resets the backoff, and keeps reconnecting afterwards", async () => {
    const attempts: number[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        attempts.push(Date.now());
        return new Response("down", { status: 502 });
      }
      return Response.json({ events: [], cursor: "" });
    });
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      reconnectBaseMs: 1000,
    });
    const t0 = Date.now();
    client.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(attempts.map((at) => at - t0)).toEqual([0, 1000, 3000]);

    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.map((at) => at - t0)).toEqual([0, 1000, 3000, 3000]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts.map((at) => at - t0)).toEqual([0, 1000, 3000, 3000, 4000]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts.map((at) => at - t0)).toEqual([0, 1000, 3000, 3000, 4000, 6000]);
    client.stop();
  });

  it("polls at once while the next poll is waiting, and does nothing while one is in flight", async () => {
    let release: (() => void) | undefined;
    let hold = false;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) return Response.json(poll);
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return Response.json({ events: [], cursor: "" });
    });
    const client = createSyncClient({ request, onEvents: vi.fn() });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const polls = () => request.mock.calls.filter(([p]) => isPoll(p)).length;
    expect(polls()).toBe(1);

    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(2);

    hold = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls()).toBe(3);
    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls()).toBe(3);
    release?.();
    client.stop();
  });

  it("does nothing while an SSE stream is open", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) return Response.json(sse);
      if (path.includes("/sync/stream")) {
        return new Response(
          sseBody(['event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n']),
          { status: 200 },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    const client = createSyncClient({ request, onEvents: vi.fn() });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const before = request.mock.calls.length;
    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.length).toBe(before);
    client.stop();
  });

  it("negotiates again at once when a refused poll left the client waiting to reconnect", async () => {
    let refused = false;
    const tokens: number[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        tokens.push(Date.now());
        return Response.json(poll);
      }
      return refused
        ? new Response(null, { status: 401 })
        : Response.json({ events: [], cursor: "" });
    });
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onUnauthorized: vi.fn(),
      reconnectBaseMs: 1000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(2500);
    refused = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.transport).toBeUndefined();
    const before = tokens.length;

    refused = false;
    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(tokens.length).toBe(before + 1);
    expect(client.transport).toBe("poll");
    client.stop();
  });

  it("lets stop end a pending backoff wait so a restart connects", async () => {
    const tokens = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        tokens();
        return new Response("down", { status: 502 });
      }
      return Response.json({ events: [], cursor: "" });
    });
    const client = createSyncClient({ request, onEvents: vi.fn(), onError: vi.fn() });
    client.start();
    await vi.advanceTimersByTimeAsync(10);
    client.stop();
    await vi.advanceTimersByTimeAsync(0);
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tokens).toHaveBeenCalledTimes(2);
    client.stop();
  });
});

describe("createSyncClient pollEveryMs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function polling(pollIntervalMs: number, every: () => number, hidden = false) {
    const times: number[] = [];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs,
        });
      }
      times.push(Date.now());
      return Response.json({ events: [], cursor: "" });
    });
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      pollEveryMs: every,
      isHidden: () => hidden,
    });
    return { client, times };
  }

  it("reads the interval each time the next poll is scheduled", async () => {
    let every = 15_000;
    const { client, times } = polling(2000, () => every);
    const t0 = Date.now();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    every = 3000;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(times.map((at) => at - t0)).toEqual([0, 15_000, 18_000]);
    client.stop();
  });

  it("never polls faster than the negotiated interval, and keeps the hidden floor", async () => {
    const fast = polling(2000, () => 500);
    const t0 = Date.now();
    fast.client.start();
    await vi.advanceTimersByTimeAsync(4100);
    expect(fast.times.map((at) => at - t0)).toEqual([0, 2000, 4000]);
    fast.client.stop();

    const hidden = polling(2000, () => 3000, true);
    const t1 = Date.now();
    hidden.client.start();
    await vi.advanceTimersByTimeAsync(20_100);
    expect(hidden.times.map((at) => at - t1)).toEqual([0, 10_000, 20_000]);
    hidden.client.stop();
  });
});

describe("createSyncClient request timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hang = (init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );

  it("fails a hung negotiation after requestTimeoutMs and keeps negotiating with backoff", async () => {
    const tokens: number[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sync/token")) {
        tokens.push(Date.now());
        return hang(init);
      }
      return Response.json({ events: [], cursor: "" });
    });
    const onError = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError,
      requestTimeoutMs: 5000,
      reconnectBaseMs: 1000,
    });
    const t0 = Date.now();
    client.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(SyncRequestTimeout);
    await vi.advanceTimersByTimeAsync(6000);
    expect(tokens.map((at) => at - t0)).toEqual([0, 6000]);
    client.stop();
  });

  it("times a hung negotiation out even when the request ignores its signal", async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith("/sync/token")
        ? new Promise<Response>(() => {})
        : Response.json({ events: [], cursor: "" }),
    );
    const onError = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError,
      requestTimeoutMs: 1000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledOnce();
    client.stop();
  });

  it("counts a hung poll as one failed poll and polls again", async () => {
    let hung = true;
    const polls: number[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs: 2000,
        });
      }
      polls.push(Date.now());
      if (hung) {
        hung = false;
        return hang(init);
      }
      return Response.json({ events: [], cursor: "" });
    });
    const onError = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError,
      requestTimeoutMs: 4000,
    });
    const t0 = Date.now();
    client.start();
    await vi.advanceTimersByTimeAsync(6100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(polls.map((at) => at - t0)).toEqual([0, 6000]);
    client.stop();
  });

  it("never times out the SSE stream", async () => {
    const encoder = new TextEncoder();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: handshake\ndata: {"protocol":1,"capabilities":[],"keepAliveMs":600000}\n\n',
                ),
              );
            },
          }),
          { status: 200 },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    const onError = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError,
      requestTimeoutMs: 1000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const streams = request.mock.calls.filter(([p]) =>
      String(p).includes("/sync/stream"),
    );
    expect(streams).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    client.stop();
  });
});

describe("createSyncClient onResume", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function sseServer() {
    let down = false;
    const request = vi.fn(async (path: string) => {
      if (down) throw new Error("offline");
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        return new Response(
          sseBody(['event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n'], {
            end: true,
          }),
          { status: 200 },
        );
      }
      return Response.json({ events: [], cursor: "" });
    });
    return {
      request,
      cut: () => (down = true),
      restore: () => (down = false),
    };
  }

  it("fires once when the stream reopens after a drop, not on the first open nor on fallback polls", async () => {
    const server = sseServer();
    const onResume = vi.fn();
    const onNegotiated = vi.fn();
    const client = createSyncClient({
      request: server.request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      onResume,
      onNegotiated,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 1000,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResume).not.toHaveBeenCalled();

    server.cut();
    await vi.advanceTimersByTimeAsync(7000);
    expect(client.transport).toBe("poll");
    expect(onNegotiated.mock.calls).toEqual([["sse"]]);
    expect(onResume).not.toHaveBeenCalled();

    server.restore();
    await vi.advanceTimersByTimeAsync(1100);
    expect(onResume).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("fires once when a poll succeeds after a failed one on a poll deployment", async () => {
    let failing = false;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sync/token")) {
        return Response.json({
          protocol: 1,
          transport: "poll",
          endpoint: "",
          pollIntervalMs: 1000,
        });
      }
      if (failing) return new Response("down", { status: 502 });
      return Response.json({ events: [], cursor: "" });
    });
    const onResume = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      onResume,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onResume).not.toHaveBeenCalled();

    failing = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onResume).not.toHaveBeenCalled();

    failing = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onResume).toHaveBeenCalledTimes(1);
    client.stop();
  });
});

describe("createSyncClient stop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const negotiated = () =>
    Response.json({ protocol: 1, transport: "poll", endpoint: "", pollIntervalMs: 100 });

  function heldPoll() {
    let signal: AbortSignal | undefined;
    const answers: ((response: Response) => void)[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sync/token")) return negotiated();
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        answers.push(resolve);
      });
    });
    return {
      request,
      answers,
      answer: (response: Response) => answers.at(-1)!(response),
      signal: () => signal,
    };
  }

  it("stop aborts an in-flight poll and drops its late events", async () => {
    const held = heldPoll();
    const onEvents = vi.fn();
    const onError = vi.fn();
    const client = createSyncClient({
      request: held.request,
      onEvents,
      onError,
      coalesceMs: 10,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(held.signal()?.aborted).toBe(false);

    client.stop();
    expect(held.signal()?.aborted).toBe(true);

    held.answer(Response.json({ events: [event(1, "a")], cursor: "1.a" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onEvents).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(client.cursor).toBe("");
    expect(held.request).toHaveBeenCalledTimes(2);
  });

  it("stop drops a late 401 without reaching onUnauthorized or onError", async () => {
    const held = heldPoll();
    const onUnauthorized = vi.fn();
    const onError = vi.fn();
    const client = createSyncClient({
      request: held.request,
      onEvents: vi.fn(),
      onError,
      onUnauthorized,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();

    held.answer(new Response("no", { status: 401 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(held.request).toHaveBeenCalledTimes(2);
  });

  describe("a stop between a request settling and its result being delivered", () => {
    function stoppedWhenSettled(held = heldPoll()) {
      let stopOnSettle = false;
      let stopClient: () => void = () => undefined;
      const onEvents = vi.fn();
      const onError = vi.fn();
      const onUnauthorized = vi.fn();
      const onResume = vi.fn();
      const client = createSyncClient({
        request: held.request,
        onEvents,
        onError,
        onUnauthorized,
        onResume,
        coalesceMs: 10,
        clearTimeout: (id) => {
          globalThis.clearTimeout(id);
          if (!stopOnSettle) return;
          stopOnSettle = false;
          stopClient();
        },
      });
      stopClient = () => client.stop();
      return {
        held,
        client,
        onEvents,
        onError,
        onUnauthorized,
        onResume,
        answerThenStop: async (response: Response) => {
          stopOnSettle = true;
          held.answer(response);
          await vi.advanceTimersByTimeAsync(0);
          expect(stopOnSettle).toBe(false);
        },
      };
    }

    it("delivers no events and moves no cursor from a poll that settled before the stop", async () => {
      const run = stoppedWhenSettled();
      run.client.start();
      await vi.advanceTimersByTimeAsync(0);

      await run.answerThenStop(Response.json({ events: [event(1, "a")], cursor: "1.a" }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run.client.cursor).toBe("");
      expect(run.onEvents).not.toHaveBeenCalled();
      expect(run.onResume).not.toHaveBeenCalled();
      expect(run.onError).not.toHaveBeenCalled();
      expect(run.held.request).toHaveBeenCalledTimes(2);
    });

    it("reports no 401 from a poll that settled before the stop", async () => {
      const run = stoppedWhenSettled();
      run.client.start();
      await vi.advanceTimersByTimeAsync(0);

      await run.answerThenStop(new Response("no", { status: 401 }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run.onUnauthorized).not.toHaveBeenCalled();
      expect(run.onError).not.toHaveBeenCalled();
      expect(run.held.request).toHaveBeenCalledTimes(2);
    });

    it("acts on no negotiation that settled before the stop", async () => {
      let answer!: (response: Response) => void;
      const request = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const onNegotiated = vi.fn();
      const onUnauthorized = vi.fn();
      let stopOnSettle = false;
      let stopClient: () => void = () => undefined;
      const client = createSyncClient({
        request,
        onEvents: vi.fn(),
        onError: vi.fn(),
        onNegotiated,
        onUnauthorized,
        clearTimeout: (id) => {
          globalThis.clearTimeout(id);
          if (!stopOnSettle) return;
          stopOnSettle = false;
          stopClient();
        },
      });
      stopClient = () => client.stop();
      client.start();
      await vi.advanceTimersByTimeAsync(0);

      stopOnSettle = true;
      answer(negotiated());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onNegotiated).not.toHaveBeenCalled();
      expect(client.transport).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  it("stop aborts an in-flight negotiation and ignores its late answer", async () => {
    let signal: AbortSignal | undefined;
    let answer!: (response: Response) => void;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sync/token")) {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return Response.json({ events: [], cursor: "" });
    });
    const onNegotiated = vi.fn();
    const onUnauthorized = vi.fn();
    const client = createSyncClient({
      request,
      onEvents: vi.fn(),
      onError: vi.fn(),
      onNegotiated,
      onUnauthorized,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    expect(signal?.aborted).toBe(true);

    answer(new Response("no", { status: 401 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    answer(negotiated());
    await vi.advanceTimersByTimeAsync(0);
    expect(onNegotiated).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("a restarted client ignores the stale poll of its previous run", async () => {
    const held = heldPoll();
    const onEvents = vi.fn();
    const client = createSyncClient({
      request: held.request,
      onEvents,
      onError: vi.fn(),
      coalesceMs: 10,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const [stale] = held.answers;
    client.stop();
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    stale!(Response.json({ events: [event(1, "old")], cursor: "1.old" }));
    await vi.advanceTimersByTimeAsync(20);
    expect(onEvents).not.toHaveBeenCalled();
    expect(client.cursor).toBe("");
    client.stop();
  });
});
