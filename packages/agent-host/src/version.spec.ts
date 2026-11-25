import { describe, expect, it } from "vitest";

import { compareVersions } from "./version.js";

describe("release versions", () => {
  it("compares major, minor and patch as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.0.1", "0.0.2")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("10.0.0", "9.99.99")).toBeGreaterThan(0);
  });

  it("refuses a version that is not major.minor.patch", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow();
    expect(() => compareVersions("1.2.3-beta", "1.2.3")).toThrow();
  });
});
