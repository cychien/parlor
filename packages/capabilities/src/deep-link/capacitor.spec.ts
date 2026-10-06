import { describe, expect, it, vi } from "vitest";

import { capacitorDeepLink } from "./capacitor.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("capacitorDeepLink", () => {
  it("delivers the launch url and later opens, and removes the listener on cancel", async () => {
    let listener: ((event: { url: string }) => void) | undefined;
    const remove = vi.fn(async () => {});
    const module = {
      App: {
        getLaunchUrl: vi.fn(async () => ({ url: "hello://launch" })),
        addListener: vi.fn(
          async (_: "appUrlOpen", handler: (e: { url: string }) => void) => {
            listener = handler;
            return { remove };
          },
        ),
      },
    };
    const api = await capacitorDeepLink(async () => module).create();
    const handler = vi.fn();
    const cancel = api.onOpen(handler);
    await tick();
    listener?.({ url: "hello://later" });
    expect(handler.mock.calls.map(([url]) => url)).toEqual([
      "hello://launch",
      "hello://later",
    ]);
    cancel();
    await tick();
    listener?.({ url: "hello://ignored" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
  });
});
