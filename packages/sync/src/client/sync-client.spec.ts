import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSyncClient } from "./sync-client.js";

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
