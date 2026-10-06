import { describe, expect, it } from "vitest";

import { assertMobileToolchain, hasAndroidSdk } from "./prerequisites.js";

describe("assertMobileToolchain", () => {
  it("explains missing Xcode and Android SDK", () => {
    expect(() => assertMobileToolchain("ios", { xcode: () => false })).toThrow(
      /xcode-select/,
    );
    expect(() => assertMobileToolchain("ios", { xcode: () => true })).not.toThrow();
    expect(() => assertMobileToolchain("android", { android: () => false })).toThrow(
      /ANDROID_HOME/,
    );
  });

  it("detects the android sdk from either env var", () => {
    expect(hasAndroidSdk({})).toBe(false);
    expect(hasAndroidSdk({ ANDROID_HOME: "/sdk" })).toBe(true);
    expect(hasAndroidSdk({ ANDROID_SDK_ROOT: "/sdk" })).toBe(true);
  });
});
