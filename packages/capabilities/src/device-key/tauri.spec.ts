import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCapability } from "../capability.js";
import { fakeApis, fakeIndexedDB, fakeKeystore } from "./spec-kit.js";
import { tauriDeviceKey, type TauriInvoke } from "./tauri.js";
import { webDeviceKey } from "./web.js";

const globals = globalThis as { __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
});

function shell(bundled: boolean | Error) {
  const store = fakeKeystore();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "parlor_host_bundled") {
      if (bundled instanceof Error) throw bundled;
      return bundled;
    }
    if (command === "parlor_device_key_public") {
      return store.publicKeys(args as { presence: boolean; challenge: string });
    }
    if (command === "parlor_device_key_sign") {
      return store.sign(args as { keyId: string; payload: string });
    }
    throw new Error(`unexpected ${command}`);
  });
  return { invoke, store, load: async () => ({ invoke }) as unknown as TauriInvoke };
}

describe("tauriDeviceKey", () => {
  it("is available only in a Tauri shell that carries the generated key commands", async () => {
    const adapter = tauriDeviceKey(shell(true).load);
    expect(adapter.platform).toBe("tauri");
    expect(await adapter.available()).toBe(false);
    globals.__TAURI_INTERNALS__ = {};
    expect(await adapter.available()).toBe(true);
    expect(await tauriDeviceKey(shell(false).load).available()).toBe(false);
    expect(
      await tauriDeviceKey(
        shell(new Error("Command parlor_host_bundled not found")).load,
      ).available(),
    ).toBe(false);
  });

  it("signs through the generated commands with camelCase arguments", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const { invoke, load } = shell(true);
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
      { name: "deviceKey", adapters: [tauriDeviceKey(shell(false).load), web] },
      "tauri",
    );
    expect(handle).toMatchObject({ available: true, platform: "web" });
  });

  it("prefers the native keys in a shell that has them", async () => {
    globals.__TAURI_INTERNALS__ = {};
    const web = webDeviceKey(fakeApis({ indexedDB: fakeIndexedDB().factory }));
    const handle = await resolveCapability(
      { name: "deviceKey", adapters: [tauriDeviceKey(shell(true).load), web] },
      "tauri",
    );
    expect(handle).toMatchObject({ available: true, platform: "tauri" });
  });
});
