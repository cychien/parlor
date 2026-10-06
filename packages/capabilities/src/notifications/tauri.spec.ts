import { afterEach, describe, expect, it, vi } from "vitest";

import { tauriNotifications } from "./tauri.js";

const tauriGlobal = globalThis as { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete tauriGlobal.__TAURI_INTERNALS__;
});

function fakePlugin(granted: boolean) {
  const sent: unknown[] = [];
  const plugin = {
    isPermissionGranted: vi.fn(async () => granted),
    requestPermission: vi.fn(async () => "granted" as const),
    sendNotification: vi.fn((options: unknown) => {
      sent.push(options);
    }),
  };
  return { plugin, sent };
}

describe("tauriNotifications", () => {
  it("is only available inside a Tauri webview", () => {
    const adapter = tauriNotifications(async () => fakePlugin(true).plugin);
    expect(adapter.available()).toBe(false);
    tauriGlobal.__TAURI_INTERNALS__ = {};
    expect(adapter.available()).toBe(true);
  });

  it("reads permission on create, requests it, and sends notifications", async () => {
    const { plugin, sent } = fakePlugin(false);
    const api = await tauriNotifications(async () => plugin).create();
    expect(api.permission()).toBe("default");
    await expect(api.show("hi")).rejects.toThrow(/not been granted/);
    await expect(api.request()).resolves.toBe("granted");
    expect(api.permission()).toBe("granted");
    await api.show("hi", { body: "there" });
    expect(sent).toEqual([{ title: "hi", body: "there" }]);
  });
});
