import { describe, expect, it } from "vitest";

import { parseTarget, resolveHandler, type TargetHandler } from "./targets.js";

describe("parseTarget", () => {
  it("defaults to web", () => {
    expect(parseTarget(undefined)).toBe("web");
  });

  it("accepts known targets and rejects unknown ones with the full list", () => {
    expect(parseTarget("mac")).toBe("mac");
    expect(() => parseTarget("osx")).toThrow(
      /Unknown target "osx".*web, ios, android, mac, windows, linux/,
    );
  });
});

describe("resolveHandler", () => {
  const handler: TargetHandler = { dev: async () => {}, build: async () => {} };

  it("returns the registered handler", () => {
    expect(resolveHandler({ web: handler }, "web")).toBe(handler);
  });

  it("explains when a target has no handler yet", () => {
    expect(() => resolveHandler({ web: handler }, "ios")).toThrow(
      /"ios" is not supported yet/,
    );
  });
});

describe("parsePort", () => {
  it("accepts a valid port and rejects garbage", async () => {
    const { parsePort } = await import("./commands/dev.js");
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort("5188")).toBe(5188);
    expect(() => parsePort("abc")).toThrow(/Invalid --port/);
    expect(() => parsePort("70000")).toThrow(/Invalid --port/);
  });
});
