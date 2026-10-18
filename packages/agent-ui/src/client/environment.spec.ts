import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserEnvironment,
  SCROLL_SETTLE_CAP_MS,
  scrollIntoCenter,
} from "./environment.js";

type Frame = () => void;

function setup(options: { reducedMotion?: boolean; tops: number[] }) {
  const frames: Frame[] = [];
  const calls: unknown[] = [];
  let index = 0;
  let clock = 0;
  const element = {
    scrollIntoView: (arguments_: unknown) => calls.push(arguments_),
    getBoundingClientRect: () => ({
      top: options.tops[Math.min(index, options.tops.length - 1)],
    }),
  };
  const window = {
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && !!options.reducedMotion,
    }),
    requestAnimationFrame: (frame: Frame) => frames.push(frame),
    performance: { now: () => clock },
  };
  let settled = false;
  const done = scrollIntoCenter(window as never, element as never).then(() => {
    settled = true;
  });
  const frame = async (advanceMs = 16) => {
    clock += advanceMs;
    index++;
    frames.shift()?.();
    await Promise.resolve();
  };
  return {
    calls,
    frame,
    done,
    settled: () => settled,
    pendingFrames: () => frames.length,
  };
}

describe("scrollIntoCenter", () => {
  it("asks for a smooth scroll to the vertical centre and settles once the element stops moving", async () => {
    const { calls, frame, settled, done } = setup({
      tops: [900, 700, 400, 300, 300, 300, 300],
    });
    expect(calls).toEqual([{ block: "center", inline: "nearest", behavior: "smooth" }]);
    for (let i = 0; i < 4; i++) await frame();
    expect(settled()).toBe(false);
    await frame();
    await frame();
    await done;
    expect(settled()).toBe(true);
  });

  it("scrolls instantly when the user prefers reduced motion", () => {
    const { calls } = setup({ reducedMotion: true, tops: [300] });
    expect(calls).toEqual([{ block: "center", inline: "nearest", behavior: "instant" }]);
  });

  it("settles after a short wait when nothing needed to scroll", async () => {
    const { frame, done, settled } = setup({ tops: [300] });
    for (let i = 0; i < 12; i++) await frame();
    await done;
    expect(settled()).toBe(true);
  });

  it("does not settle on the frames before a smooth scroll has begun to move", async () => {
    const { frame, settled } = setup({ tops: [900, 900, 900, 700, 500, 300, 300, 300] });
    await frame();
    await frame();
    expect(settled()).toBe(false);
  });

  it("gives up at the cap even if the element keeps moving", async () => {
    const { frame, done, settled } = setup({
      tops: Array.from({ length: 200 }, (_, i) => i),
    });
    await frame(SCROLL_SETTLE_CAP_MS);
    await done;
    expect(settled()).toBe(true);
  });
});

describe("browserEnvironment hasFinePointer", () => {
  afterEach(() => vi.unstubAllGlobals());

  const withPointer = (pointer: "fine" | "coarse" | "none") => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query === `(pointer: ${pointer})` }),
    });
    return browserEnvironment().hasFinePointer();
  };

  it("is true for a mouse or trackpad", () => {
    expect(withPointer("fine")).toBe(true);
  });

  it.each(["coarse", "none"] as const)(
    "is false when the primary pointer is %s",
    (pointer) => {
      expect(withPointer(pointer)).toBe(false);
    },
  );

  it("is false without a window", () => {
    expect(browserEnvironment().hasFinePointer()).toBe(false);
  });
});
