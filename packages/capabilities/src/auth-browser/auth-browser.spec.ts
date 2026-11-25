import { describe, expect, it, vi } from "vitest";

import { webAuthBrowser } from "./web.js";

const PAGE = "https://accounts.example.com/authorize?client_id=app";

const pending = Symbol("pending");
const settledWithin = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 20, pending))]);

describe("webAuthBrowser", () => {
  it("sends the page itself to the provider and never settles, since the page leaves", async () => {
    const assign = vi.fn();
    const api = await webAuthBrowser(() => ({ assign })).create();
    expect(await settledWithin(api.open(PAGE, "https://app.example.com/"))).toBe(pending);
    expect(assign).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it("is available only where there is a page", () => {
    expect(webAuthBrowser(() => ({ assign: vi.fn() })).available()).toBe(true);
    expect(webAuthBrowser(() => undefined).available()).toBe(false);
  });
});
