import { describe, expect, it } from "vitest";

import { parsePort } from "./commands/dev.js";
import {
  parseTarget,
  parseTargets,
  resolveHandler,
  type TargetHandler,
} from "./targets.js";

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

describe("parseTargets", () => {
  it("defaults to web and takes several joined by commas, each once, in order", () => {
    expect(parseTargets(undefined)).toEqual(["web"]);
    expect(parseTargets("mac")).toEqual(["mac"]);
    expect(parseTargets("web, mac,web")).toEqual(["web", "mac"]);
  });

  it("rejects an unknown target in the list", () => {
    expect(() => parseTargets("web,osx")).toThrow(/Unknown target "osx"/);
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
  it("accepts a valid port and rejects garbage", () => {
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort("5188")).toBe(5188);
    expect(() => parsePort("abc")).toThrow(/Invalid --port/);
    expect(() => parsePort("70000")).toThrow(/Invalid --port/);
  });
});
