import { describe, expect, it } from "vitest";

import { assertHostMatches } from "./desktop-target.js";

describe("assertHostMatches", () => {
  it("allows the host's own target and rejects others", () => {
    expect(() => assertHostMatches("mac", "darwin")).not.toThrow();
    expect(() => assertHostMatches("windows", "darwin")).toThrow(
      /This machine builds "mac"/,
    );
    expect(() => assertHostMatches("linux", "freebsd")).toThrow(/builds "nothing"/);
  });
});
