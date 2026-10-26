import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStreamingText } from "./use-streaming-text.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const stream = (text: string, streaming = true) =>
  renderHook((props) => useStreamingText(props.text, props.streaming), {
    initialProps: { text, streaming },
  });

/** A frame at a time: React commits a frame's update, and schedules the next, as each act ends. */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 16) {
    await act(() => vi.advanceTimersByTimeAsync(Math.min(16, left)));
  }
  if (ms === 0) await act(() => vi.advanceTimersByTimeAsync(0));
}

describe("useStreamingText", () => {
  it("shows the text there at mount at once", () => {
    expect(stream("Already here.", false).result.current).toBe("Already here.");
    expect(stream("Streaming so far").result.current).toBe("Streaming so far");
  });

  it("spreads a batch over the time until the next one, a little each frame", async () => {
    const view = stream("");
    const batch = "x".repeat(100);
    view.rerender({ text: batch, streaming: true });
    expect(view.result.current).toBe("");

    await advance(64);
    const early = view.result.current.length;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(60);
    await advance(96);
    expect(view.result.current.length).toBeGreaterThan(early);
    await advance(300);
    expect(view.result.current).toBe(batch);
  });

  it("paces itself to how often batches come", async () => {
    const view = stream("");
    let text = "";
    for (let batch = 0; batch < 6; batch++) {
      text += "y".repeat(60);
      view.rerender({ text, streaming: true });
      await advance(500);
    }
    text += "y".repeat(60);
    view.rerender({ text, streaming: true });
    await advance(250);
    const midway = view.result.current.length - (text.length - 60);
    expect(midway).toBeGreaterThan(10);
    expect(midway).toBeLessThan(50);
  });

  it("shows the rest within a moment once streaming ends", async () => {
    const view = stream("");
    view.rerender({ text: "z".repeat(400), streaming: true });
    await advance(32);
    view.rerender({ text: "z".repeat(400), streaming: false });
    await advance(250);
    expect(view.result.current).toHaveLength(400);
  });

  it("shows text that does not continue what is shown whole", async () => {
    const view = stream("");
    view.rerender({ text: "first reply, streaming", streaming: true });
    await advance(64);
    view.rerender({ text: "another reply", streaming: true });
    await advance(0);
    expect(view.result.current).toBe("another reply");
  });

  it("never shows half of an emoji", async () => {
    const view = stream("");
    const text = "😀".repeat(40);
    view.rerender({ text, streaming: true });
    for (let frame = 0; frame < 20; frame++) {
      await advance(32);
      const shown = view.result.current;
      expect(shown.length % 2).toBe(0);
      expect(text.startsWith(shown)).toBe(true);
    }
  });
});
