import { describe, expect, it } from "vitest";

import { resolvePreset, syncTransportFor } from "./presets.js";

describe("resolvePreset", () => {
  it("prefers the flag, then config, then CI env, then node-server", () => {
    expect(resolvePreset("vercel", "netlify", { VERCEL: "1" })).toEqual({
      preset: "vercel",
      reason: "flag",
    });
    expect(resolvePreset(undefined, "netlify", { VERCEL: "1" })).toEqual({
      preset: "netlify",
      reason: "config",
    });
    expect(resolvePreset(undefined, undefined, { VERCEL: "1" })).toEqual({
      preset: "vercel",
      reason: "ci",
    });
    expect(resolvePreset(undefined, undefined, { CF_PAGES: "1" }).preset).toBe(
      "cloudflare-module",
    );
    expect(resolvePreset(undefined, undefined, {})).toEqual({
      preset: "node-server",
      reason: "default",
    });
  });

  it("rejects unknown presets with the list", () => {
    expect(() => resolvePreset("heroku", undefined, {})).toThrow(
      /Unknown deploy preset "heroku"/,
    );
  });
});

describe("syncTransportFor", () => {
  it("uses SSE on long-lived hosts and polling on serverless ones", () => {
    expect(syncTransportFor("node-server")).toBe("sse");
    expect(syncTransportFor("bun")).toBe("sse");
    expect(syncTransportFor("vercel")).toBe("poll");
    expect(syncTransportFor("cloudflare-module")).toBe("poll");
  });
});
