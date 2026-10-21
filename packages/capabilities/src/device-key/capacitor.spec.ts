import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCapability } from "../capability.js";
import { capacitorDeviceKey, type CapacitorDeviceKeyModule } from "./capacitor.js";
import { fakeApis, fakeIndexedDB, fakeKeystore } from "./spec-kit.js";
import { webDeviceKey } from "./web.js";

const globals = globalThis as { Capacitor?: unknown };
afterEach(() => {
  delete globals.Capacitor;
});

const inShell = (platform: "ios" | "android") => {
  globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform };
};

const plugin = () => {
  const store = fakeKeystore();
  const publicKeys = vi.fn(store.publicKeys);
  return {
    publicKeys,
    load: async () =>
      ({
        ParlorDeviceKey: { publicKeys, sign: store.sign },
      }) satisfies CapacitorDeviceKeyModule,
  };
};

describe("capacitorDeviceKey", () => {
  it("is available on iOS only, where the plugin has an implementation", () => {
    const adapter = capacitorDeviceKey(plugin().load);
    expect(adapter.platform).toBe("capacitor");
    expect(adapter.available()).toBe(false);
    inShell("android");
    expect(adapter.available()).toBe(false);
    inShell("ios");
    expect(adapter.available()).toBe(true);
  });

  it("enrolls and signs through the ParlorDeviceKey plugin", async () => {
    inShell("ios");
    const { load, publicKeys } = plugin();
    const device = await capacitorDeviceKey(load).create();
    const keys = await device.publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "alice",
      challenge: new Uint8Array([1]),
    });
    expect(publicKeys).toHaveBeenCalledWith({ presence: true, challenge: "AQ" });
    expect(keys.presence).toMatchObject({ format: "es256-raw" });
    const signature = await device.sign(new Uint8Array([2]), { presence: true });
    expect(signature).toMatchObject({ presence: "user", keyId: keys.presence!.keyId });
  });

  it("leaves Android the web adapter's keys", async () => {
    inShell("android");
    const web = webDeviceKey(fakeApis({ indexedDB: fakeIndexedDB().factory }));
    const handle = await resolveCapability(
      { name: "deviceKey", adapters: [capacitorDeviceKey(plugin().load), web] },
      "capacitor",
    );
    expect(handle).toMatchObject({ available: true, platform: "web" });
  });
});
