import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCapability } from "../capability.js";
import { fakeApis, fakeIndexedDB, fakeKeystore } from "./spec-kit.js";
import { tauriDeviceKey, type TauriInvoke } from "./tauri.js";
import { webDeviceKey } from "./web.js";

const globals = globalThis as { __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
});

function shell(commands: "present" | "missing" | "unsupported") {
  const store = fakeKeystore();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (commands === "missing") throw `Command ${command} not found`;
    if (commands === "unsupported") throw "unsupported";
    if (command === "parlor_device_key_public") {
      return store.publicKeys(args as { presence: boolean; challenge: string });
    }
    if (command === "parlor_device_key_sign") {
      if (args?.keyId === "") throw "This device has no such key.";
      return store.sign(args as { keyId: string; payload: string });
    }
    throw new Error(`unexpected ${command}`);
  });
  return { invoke, store, load: async () => ({ invoke }) as unknown as TauriInvoke };
}

describe("tauriDeviceKey", () => {
  it("is available in a Tauri shell without asking whether a host is bundled", async () => {
    const present = shell("present");
    const adapter = tauriDeviceKey(present.load);
    expect(adapter.platform).toBe("tauri");
    expect(await adapter.available()).toBe(false);
    globals.__TAURI_INTERNALS__ = {};
    expect(await adapter.available()).toBe(true);
    expect(present.invoke).not.toHaveBeenCalledWith("parlor_host_bundled");
    expect(present.invoke).not.toHaveBeenCalledWith(
      "parlor_device_key_public",
      expect.anything(),
    );
  });

  it("is unavailable when the shell lacks the key commands or cannot hold keys", async () => {
    globals.__TAURI_INTERNALS__ = {};
    expect(await tauriDeviceKey(shell("missing").load).available()).toBe(false);
    expect(await tauriDeviceKey(shell("unsupported").load).available()).toBe(false);
  });

  it("signs through the generated commands with camelCase arguments", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const { invoke, load } = shell("present");
    const device = await tauriDeviceKey(load).create();
    const keys = await device.publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "alice",
      challenge: new Uint8Array([1]),
    });
    expect(invoke).toHaveBeenCalledWith("parlor_device_key_public", {
      presence: true,
      challenge: "AQ",
    });
    await device.sign(new Uint8Array([7]), { presence: true });
    expect(invoke).toHaveBeenCalledWith("parlor_device_key_sign", {
      keyId: keys.presence!.keyId,
      payload: "Bw",
    });
  });

  it("leaves a shell without the key commands the web adapter's keys", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const web = webDeviceKey(fakeApis({ indexedDB: fakeIndexedDB().factory }));
    const handle = await resolveCapability(
      { name: "deviceKey", adapters: [tauriDeviceKey(shell("missing").load), web] },
      "tauri",
    );
    expect(handle).toMatchObject({ available: true, platform: "web" });
  });

  it("prefers the native keys in a shell that has them", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const web = webDeviceKey(fakeApis({ indexedDB: fakeIndexedDB().factory }));
    const handle = await resolveCapability(
      { name: "deviceKey", adapters: [tauriDeviceKey(shell("present").load), web] },
      "tauri",
    );
    expect(handle).toMatchObject({ available: true, platform: "tauri" });
  });
});
