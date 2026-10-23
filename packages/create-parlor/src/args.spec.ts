import { describe, expect, it } from "vitest";

import { canPrompt, parseCreateArgs } from "./args.js";

describe("create-parlor arguments", () => {
  it("takes every default with only a directory", () => {
    expect(parseCreateArgs(["my-app"])).toEqual({
      directory: "my-app",
      yes: false,
      install: true,
      git: true,
      packageManager: undefined,
      addons: [],
      dryRun: false,
      help: false,
      version: false,
    });
  });

  it("reads the flags an agent passes", () => {
    const request = parseCreateArgs([
      "my-app",
      "--yes",
      "--no-install",
      "--no-git",
      "--package-manager",
      "bun",
      "--add",
      "auth",
      "--add",
      "auth",
      "--dry-run",
      "--",
    ]);
    expect(request).toMatchObject({
      directory: "my-app",
      yes: true,
      install: false,
      git: false,
      packageManager: "bun",
      addons: ["auth"],
      dryRun: true,
    });
  });

  it("refuses an unknown package manager, option or a second directory", () => {
    expect(() => parseCreateArgs(["--package-manager", "cargo"])).toThrow(/cargo/);
    expect(() => parseCreateArgs(["--add", "payments"])).toThrow(/payments/);
    expect(() => parseCreateArgs(["--template", "x"])).toThrow();
    expect(() => parseCreateArgs(["a", "b"])).toThrow(/one directory/);
  });

  it("prompts only on a terminal outside CI", () => {
    expect(canPrompt({ isTTY: true }, { isTTY: true }, {})).toBe(true);
    expect(canPrompt({ isTTY: true }, { isTTY: true }, { CI: "1" })).toBe(false);
    expect(canPrompt({ isTTY: false }, { isTTY: true }, {})).toBe(false);
    expect(canPrompt({}, {}, {})).toBe(false);
  });
});
