import { describe, expect, it } from "vitest";

import { parseSimctlList, pickIosSimulator } from "./simulators.js";

const list = parseSimctlList(
  JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        { udid: "A", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
        { udid: "B", name: "iPad (A16)", state: "Shutdown", isAvailable: true },
        { udid: "C", name: "iPhone 17", state: "Shutdown", isAvailable: true },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-4": [
        { udid: "D", name: "iPhone 16", state: "Booted", isAvailable: true },
        { udid: "E", name: "iPhone 15", state: "Shutdown", isAvailable: false },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
        { udid: "W", name: "Apple Watch", state: "Shutdown", isAvailable: true },
      ],
    },
  }),
);

describe("parseSimctlList", () => {
  it("keeps only available iOS devices", () => {
    expect(list.map((s) => s.udid)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("pickIosSimulator", () => {
  it("prefers a booted simulator", () => {
    expect(pickIosSimulator(list).udid).toBe("D");
  });

  it("otherwise picks the newest iPhone by runtime, then name", () => {
    const shutdown = list.map((s) => ({ ...s, state: "Shutdown" }));
    expect(pickIosSimulator(shutdown).name).toBe("iPhone 17");
  });

  it("honours a preferred name or udid and explains misses", () => {
    expect(pickIosSimulator(list, "iPad (A16)").udid).toBe("B");
    expect(pickIosSimulator(list, "C").name).toBe("iPhone 17");
    expect(() => pickIosSimulator(list, "iPhone 3G")).toThrow(/Available: iPhone 17 Pro/);
  });

  it("fails clearly with no simulators", () => {
    expect(() => pickIosSimulator([])).toThrow(/No iOS simulators/);
  });
});
