import { describe, expect, it } from "vitest";

import { resolveCapability } from "../capability.js";
import { capacitorDeviceKey } from "./capacitor.js";
import { fakeApis, fakeIndexedDB } from "./spec-kit.js";
import { webDeviceKey } from "./web.js";

describe("capacitorDeviceKey", () => {
  it("reports itself unavailable until the mobile shell provides the keys", () => {
    const adapter = capacitorDeviceKey();
    expect(adapter.platform).toBe("capacitor");
    expect(adapter.available()).toBe(false);
    expect(() => adapter.create()).toThrow(/arrives with the mobile shell/);
  });

  it("leaves a mobile shell the web adapter's keys", async () => {
    const web = webDeviceKey(fakeApis({ indexedDB: fakeIndexedDB().factory }));
    const handle = await resolveCapability(
      { name: "deviceKey", adapters: [capacitorDeviceKey(), web] },
      "capacitor",
    );
    expect(handle).toMatchObject({ available: true, platform: "web" });
  });
});
