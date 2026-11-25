import { describe, expect, it } from "vitest";

import {
  type CapabilityAdapter,
  defineCapability,
  resolveCapability,
} from "./capability.js";

function adapter(name: string, available: boolean): CapabilityAdapter<string> {
  return { available: () => available, create: () => `${name}-api` };
}

describe("resolveCapability", () => {
  it("uses the first available adapter", async () => {
    const cap = defineCapability({
      name: "x",
      adapters: [adapter("a", false), adapter("b", true), adapter("c", true)],
    });
    expect(await resolveCapability(cap)).toEqual({ available: true, api: "b-api" });
  });

  it("reports unavailability with the capability name", async () => {
    const cap = defineCapability({ name: "camera", adapters: [adapter("a", false)] });
    expect(await resolveCapability(cap)).toEqual({
      available: false,
      reason: 'Capability "camera" is not available in this browser',
    });
  });
});
