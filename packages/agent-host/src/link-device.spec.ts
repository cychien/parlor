import { deviceCommitment, linkCode } from "@parlor/auth";
import { describe, expect, it, vi } from "vitest";

import { linkDevice } from "./link-device.js";
import { memoryTrust, TestDevice } from "./spec-kit.js";

const APP = "https://hello.example";

async function codeOf(device: TestDevice) {
  return linkCode(
    await deviceCommitment(
      APP,
      device.id,
      device.keys.signingKey,
      device.keys.presenceKey?.publicKey,
    ),
  );
}

function appReturning(device: TestDevice, keys = device.keys) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe("/_parlor/auth/hosts/devices/link");
    expect(request.headers.get("authorization")).toBe("ParlorHost assertion");
    return Response.json({
      id: device.id,
      name: device.keys.name,
      platform: device.keys.platform,
      signingKey: keys.signingKey,
      presenceKey: keys.presenceKey,
    });
  });
}

describe("linkDevice from the computer", () => {
  it("pins the device showing the code once the user confirms here", async () => {
    const phone = await TestDevice.create("device-phone", "Chrome on iPhone", "web");
    const trust = memoryTrust();
    const confirm = vi.fn(async () => true);
    const outcome = await linkDevice({
      appOrigin: APP,
      code: await codeOf(phone),
      assert: async () => "assertion",
      trust,
      confirm,
      now: () => 7,
      fetch: appReturning(phone),
    });
    expect(confirm).toHaveBeenCalledWith({ name: "Chrome on iPhone", platform: "web" });
    expect(outcome).toMatchObject({ linked: true });
    expect(await trust.get(APP, phone.id)).toEqual({
      deviceId: phone.id,
      signingKey: phone.keys.signingKey,
      presenceKey: phone.keys.presenceKey,
      name: "Chrome on iPhone",
      platform: "web",
      approvedAt: 7,
      via: "local",
    });
  });

  it("A3: links nothing when the app returns keys that do not hash to the code", async () => {
    const phone = await TestDevice.create("device-phone");
    const attacker = await TestDevice.create("device-phone");
    const trust = memoryTrust();
    const confirm = vi.fn(async () => true);
    await expect(
      linkDevice({
        appOrigin: APP,
        code: await codeOf(phone),
        assert: async () => "assertion",
        trust,
        confirm,
        fetch: appReturning(phone, attacker.keys),
      }),
    ).rejects.toThrow(/do not match this code/);
    expect(confirm).not.toHaveBeenCalled();
    expect(trust.pins()).toEqual([]);
  });

  it("links nothing when the user says no here", async () => {
    const phone = await TestDevice.create("device-phone");
    const trust = memoryTrust();
    expect(
      await linkDevice({
        appOrigin: APP,
        code: await codeOf(phone),
        assert: async () => "assertion",
        trust,
        confirm: async () => false,
        fetch: appReturning(phone),
      }),
    ).toEqual({ linked: false });
    expect(trust.pins()).toEqual([]);
  });
});
