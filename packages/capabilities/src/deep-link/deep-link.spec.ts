import { describe, expect, it, vi } from "vitest";

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
