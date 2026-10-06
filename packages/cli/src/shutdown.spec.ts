import { describe, expect, it } from "vitest";

import { onShutdown } from "./shutdown.js";

describe("onShutdown", () => {
  it("runs every cleanup once and re-raises the signal with default handling", async () => {
    const calls: string[] = [];
    onShutdown(() => {
      calls.push("a");
    });
    onShutdown(async () => {
      calls.push("b");
    });

    const originalKill = process.kill;
    const killed: Array<[number, string | number | undefined]> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killed.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      process.emit("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.kill = originalKill;
    }

    expect(calls).toEqual(["a", "b"]);
    expect(killed).toEqual([[process.pid, "SIGINT"]]);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });
});
