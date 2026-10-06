import { describe, expect, it } from "vitest";

import { assertRustToolchain, hasCargo } from "./prerequisites.js";

describe("assertRustToolchain", () => {
  it("passes when cargo answers and explains how to install it otherwise", () => {
    expect(() => assertRustToolchain(() => true)).not.toThrow();
    expect(() => assertRustToolchain(() => false)).toThrow(/rustup\.rs/);
  });

  it("treats a non-zero or missing cargo as absent", () => {
    expect(hasCargo((() => ({ status: 1 })) as never)).toBe(false);
    expect(
      hasCargo((() => ({ status: null, error: new Error("ENOENT") })) as never),
    ).toBe(false);
    expect(hasCargo((() => ({ status: 0 })) as never)).toBe(true);
  });
});
