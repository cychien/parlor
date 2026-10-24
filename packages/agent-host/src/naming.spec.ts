import { describe, expect, it } from "vitest";

import { unsupportedHostPlatform } from "./naming.js";

describe("the platforms Parlor Host connects from", () => {
  it("is macOS only for now, and says why on Windows and Linux before any pairing", () => {
    expect(unsupportedHostPlatform("darwin")).toBeUndefined();
    expect(unsupportedHostPlatform("linux")).toBe(
      "Parlor Host connects to apps from macOS only for now; Linux is not supported yet, because it keeps its keys in the macOS Keychain. `parlor dev` works on every platform.",
    );
    expect(unsupportedHostPlatform("win32")).toContain("Windows is not supported yet");
  });
});
