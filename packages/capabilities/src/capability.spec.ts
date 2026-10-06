import { describe, expect, it } from "vitest";

import {
  type CapabilityAdapter,
  defineCapability,
  resolveCapability,
} from "./capability.js";
import { detectPlatform } from "./runtime.js";

function adapter(
  platform: "web" | "capacitor" | "tauri",
  available: boolean,
): CapabilityAdapter<string> {
  return { platform, available: () => available, create: () => `${platform}-api` };
}

describe("detectPlatform", () => {
  it("recognises tauri, capacitor, and defaults to web", () => {
    expect(detectPlatform({ __TAURI_INTERNALS__: {} })).toBe("tauri");
    expect(detectPlatform({ Capacitor: { isNativePlatform: () => true } })).toBe(
      "capacitor",
    );
    expect(detectPlatform({ Capacitor: { isNativePlatform: () => false } })).toBe("web");
    expect(detectPlatform({})).toBe("web");
  });
});

describe("resolveCapability", () => {
  it("prefers the adapter for the current platform", async () => {
    const cap = defineCapability({
      name: "x",
      adapters: [adapter("web", true), adapter("tauri", true)],
    });
    const handle = await resolveCapability(cap, "tauri");
    expect(handle).toEqual({ available: true, platform: "tauri", api: "tauri-api" });
  });

  it("falls back to the web baseline when the native adapter is unavailable", async () => {
    const cap = defineCapability({
      name: "x",
      adapters: [adapter("web", true), adapter("capacitor", false)],
    });
    const handle = await resolveCapability(cap, "capacitor");
    expect(handle).toMatchObject({ available: true, platform: "web" });
  });

  it("reports unavailability with the capability name and platform", async () => {
    const cap = defineCapability({ name: "camera", adapters: [adapter("web", false)] });
    const handle = await resolveCapability(cap, "web");
    expect(handle).toEqual({
      available: false,
      reason: 'Capability "camera" has no available adapter on web',
    });
  });

  it("does not use a native adapter on the web", async () => {
    const cap = defineCapability({ name: "x", adapters: [adapter("tauri", true)] });
    expect(await resolveCapability(cap, "web")).toMatchObject({ available: false });
  });
});
