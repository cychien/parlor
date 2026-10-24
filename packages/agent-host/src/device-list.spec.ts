import { describe, expect, it } from "vitest";

import { describeDevices, removeDevice } from "./device-list.js";
import { memoryTrust } from "./spec-kit.js";
import type { TrustedDevice } from "./trust.js";

const APP = "https://hello.test";
const KEY = { kty: "EC", crv: "P-256", x: "x", y: "y" };

const device = (
  deviceId: string,
  name: string,
  approvedAt: number,
  via: TrustedDevice["via"],
  voucher?: string,
): TrustedDevice => ({
  deviceId,
  signingKey: KEY,
  name,
  platform: "web",
  approvedAt,
  via,
  voucher,
});

describe("parlor-host devices", () => {
  it("lists each linked device with when and how it was linked, oldest first", () => {
    const laptop = device(
      "dev_laptop",
      "Chrome on macOS",
      new Date(2026, 9, 20).getTime(),
      "pairing",
    );
    const phone = device(
      "dev_phone",
      "Safari on iPhone",
      new Date(2026, 9, 23).getTime(),
      "vouched",
      "dev_laptop",
    );
    const tablet = device(
      "dev_tab",
      "Chrome on iPad",
      new Date(2026, 9, 22).getTime(),
      "local",
    );
    const orphan = device(
      "dev_old",
      "Edge",
      new Date(2026, 9, 24).getTime(),
      "vouched",
      "dev_gone",
    );
    expect(describeDevices("My App", [phone, laptop, tablet, orphan])).toBe(
      [
        "Devices that can use your agents for My App:",
        "  dev_laptop  Chrome on macOS, 2026-10-20, approved connect on this computer",
        "  dev_tab  Chrome on iPad, 2026-10-22, linked on this computer",
        "  dev_phone  Safari on iPhone, 2026-10-23, linked from Chrome on macOS",
        "  dev_old  Edge, 2026-10-24, linked from a removed device",
        "",
      ].join("\n"),
    );
  });

  it("says how to link one when none is", () => {
    expect(describeDevices("My App", [])).toBe(
      "No device can use your agents for My App yet. Open the app's Agent sidebar on one to link it.\n",
    );
  });

  it("removes one device and refuses an unknown id", async () => {
    const trust = memoryTrust();
    await trust.pin(APP, device("dev_laptop", "Chrome on macOS", 1, "pairing"));
    await trust.pin(
      APP,
      device("dev_phone", "Safari on iPhone", 2, "vouched", "dev_laptop"),
    );
    expect(await removeDevice(trust, APP, "dev_phone")).toMatchObject({
      name: "Safari on iPhone",
    });
    expect((await trust.list(APP)).map((pinned) => pinned.deviceId)).toEqual([
      "dev_laptop",
    ]);
    await expect(removeDevice(trust, APP, "dev_phone")).rejects.toThrow(
      "No linked device dev_phone. Run `npx @parlor/agent-host devices https://hello.test` to list them.",
    );
  });
});
