import { describe, expect, it } from "vitest";

import { parseSseChunk, readSse } from "./sse.js";

describe("parseSseChunk", () => {
  it("splits complete frames, keeps partial tail, skips comments", () => {
    const { frames, rest } = parseSseChunk(
      ': keep-alive\n\nevent: handshake\ndata: {"a":1}\n\ndata: x\ndata: y\n\ndata: partial',
    );
    expect(frames).toEqual([
      { event: "handshake", data: '{"a":1}' },
      { event: "message", data: "x\ny" },
    ]);
    expect(rest).toBe("data: partial");
  });
});

describe("readSse", () => {
  it("reads frames across chunk boundaries and stops on abort", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: fir"));
        controller.enqueue(encoder.encode("st\n\ndata: second\n\n"));
        controller.close();
      },
    });
    const frames: string[] = [];
    await readSse(body, (frame) => frames.push(frame.data));
    expect(frames).toEqual(["first", "second"]);
  });
});
