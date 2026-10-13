import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSyncClient } from "./sync-client.js";

function sseBody(frames: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
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
