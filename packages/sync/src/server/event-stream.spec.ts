import { describe, expect, it, vi } from "vitest";

import { createEventStream, SlowConsumer } from "./event-stream.js";

const decoder = new TextDecoder();

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of body) text += decoder.decode(chunk);
  return text;
}

describe("createEventStream", () => {
  it("writes named events, one data line per line of data, and comments", async () => {
    const stream = createEventStream();
    stream.push({ event: "handshake", data: "{}" });
    stream.push({ data: "a\nb" });
    stream.comment("keep-alive");
    stream.close();

    await expect(readAll(stream.body)).resolves.toBe(
      "event: handshake\ndata: {}\n\ndata: a\ndata: b\n\n: keep-alive\n\n",
    );
  });

  it("drops a reader that falls more than maxQueuedBytes behind, and closes once", async () => {
    const stream = createEventStream(100);
    const onClosed = vi.fn();
    stream.onClosed(onClosed);
    for (let i = 0; i < 10; i += 1) stream.push({ data: "x".repeat(20) });

    expect(onClosed).toHaveBeenCalledTimes(1);
    await expect(stream.body.getReader().read()).rejects.toBeInstanceOf(SlowConsumer);
    stream.push({ data: "late" });
    stream.close();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("takes a frame larger than maxQueuedBytes into an empty queue", async () => {
    const stream = createEventStream(100);
    const onClosed = vi.fn();
    stream.onClosed(onClosed);
    stream.push({ data: "x".repeat(500) });
    stream.close();

    await expect(readAll(stream.body)).resolves.toBe(`data: ${"x".repeat(500)}\n\n`);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("keeps a reader that keeps up, however much passes through", async () => {
    const stream = createEventStream(100);
    const reader = stream.body.getReader();
    for (let i = 0; i < 50; i += 1) {
      stream.push({ data: "x".repeat(40) });
      stream.push({ data: "y".repeat(40) });
      await reader.read();
      await reader.read();
    }
    stream.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("resolves drained once the reader has taken everything queued", async () => {
    const stream = createEventStream();
    await expect(stream.drained()).resolves.toBeUndefined();
    stream.push({ data: "one" });
    stream.push({ data: "two" });
    let drained = false;
    void stream.drained().then(() => (drained = true));
    const reader = stream.body.getReader();

    await reader.read();
    await Promise.resolve();
    expect(drained).toBe(false);
    await reader.read();
    await vi.waitFor(() => expect(drained).toBe(true));
  });

  it("resolves drained and runs onClosed when the reader cancels", async () => {
    const stream = createEventStream();
    const onClosed = vi.fn();
    stream.onClosed(onClosed);
    stream.push({ data: "unread" });
    const drained = stream.drained();

    await stream.body.cancel();
    await expect(drained).resolves.toBeUndefined();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
