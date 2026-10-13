import { describe, expect, it } from "vitest";

import { assertIosHost } from "./mobile-target.js";

describe("assertIosHost", () => {
  it("requires macOS for ios and allows android anywhere", () => {
    expect(() => assertIosHost("ios", "darwin")).not.toThrow();
    expect(() => assertIosHost("ios", "linux")).toThrow(/only be built on macOS/);
    expect(() => assertIosHost("android", "linux")).not.toThrow();
  });
});
