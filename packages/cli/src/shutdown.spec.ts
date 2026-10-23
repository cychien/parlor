import { describe, expect, it } from "vitest";

import { onShutdown, shutdownAfterError } from "./shutdown.js";

describe("onShutdown", () => {
  it("runs every cleanup once and re-raises the signal with default handling", async () => {
    const calls: string[] = [];
    onShutdown((signaled) => {
      calls.push(`a:${signaled}`);
    });
    onShutdown(async (signaled) => {
      calls.push(`b:${signaled}`);
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

    expect(calls).toEqual(["a:true", "b:true"]);
    expect(killed).toEqual([[process.pid, "SIGINT"]]);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("runs every cleanup once, unsignaled, when the CLI stops on its own error", async () => {
    const calls: string[] = [];
    onShutdown((signaled) => {
      calls.push(`a:${signaled}`);
    });
    onShutdown(async (signaled) => {
      calls.push(`b:${signaled}`);
    });

    await shutdownAfterError();
    await shutdownAfterError();

    expect(calls).toEqual(["a:false", "b:false"]);
  });
});
