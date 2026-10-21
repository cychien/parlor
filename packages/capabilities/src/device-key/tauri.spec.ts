import { describe, expect, it } from "vitest";

import { resolveCapability } from "../capability.js";
import { fakeApis, fakeIndexedDB } from "./spec-kit.js";
import { tauriDeviceKey } from "./tauri.js";
import { webDeviceKey } from "./web.js";

describe("tauriDeviceKey", () => {
  it("reports itself unavailable until the desktop shell provides the keys", () => {
    const adapter = tauriDeviceKey();
    expect(adapter.platform).toBe("tauri");
    expect(adapter.available()).toBe(false);
    expect(() => adapter.create()).toThrow(/arrives with the desktop shell/);
  });

  it("leaves a desktop shell the web adapter's keys", async () => {
    const web = webDeviceKey(fakeApis({ indexedDB: fakeIndexedDB().factory }));
    const handle = await resolveCapability(
      { name: "deviceKey", adapters: [tauriDeviceKey(), web] },
      "tauri",
    );
    expect(handle).toMatchObject({ available: true, platform: "web" });
  });
});
