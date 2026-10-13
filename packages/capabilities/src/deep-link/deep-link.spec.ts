import { describe, expect, it, vi } from "vitest";

import { tauriDeepLink } from "./tauri.js";
import { webDeepLink } from "./web.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("webDeepLink", () => {
  it("delivers the current url once and supports cancelling", async () => {
    const api = webDeepLink(() => "https://app.test/x").create();
    const handler = vi.fn();
    api.onOpen(handler);
    const cancelled = vi.fn();
    api.onOpen(cancelled)();
    await tick();
    expect(handler).toHaveBeenCalledExactlyOnceWith("https://app.test/x");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("is unavailable without a location", () => {
    expect(webDeepLink(() => undefined).available()).toBe(false);
  });
});

describe("tauriDeepLink", () => {
  it("delivers launch urls and later opens, and unlistens on cancel", async () => {
    let listener: ((urls: string[]) => void) | undefined;
    const stop = vi.fn();
    const plugin = {
      getCurrent: vi.fn(async () => ["hello://launch"]),
      onOpenUrl: vi.fn(async (handler: (urls: string[]) => void) => {
        listener = handler;
        return stop;
      }),
    };
    const api = await tauriDeepLink(async () => plugin).create();
    const handler = vi.fn();
    const cancel = api.onOpen(handler);
    await tick();
    listener?.(["hello://later"]);
    expect(handler.mock.calls.map(([url]) => url)).toEqual([
      "hello://launch",
      "hello://later",
    ]);
    cancel();
    await tick();
    listener?.(["hello://ignored"]);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });
});
