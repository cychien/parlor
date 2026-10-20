import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { parseConfig } from "@parlor/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDevAgentHost } from "./agent-host-process.js";

const loadedOn = (port: number) => ({
  config: parseConfig({
    app: { id: "dev.parlor.test", name: "Test" },
    server: { port },
  }),
  rootDir: process.cwd(),
  configFile: "parlor.config.ts",
});
const loaded = loadedOn(3999);
const EXIT_BOUND_MS = 3_000;

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
});

describe("startDevAgentHost", () => {
  it("runs parlor-host dev against the app server next to it", () => {
    const child = startDevAgentHost(loaded, { enabled: true, serverHasAuth: false });
    expect(child).toBeDefined();
    started.push(child!);
    expect(child!.spawnargs.slice(-3)).toEqual(["dev", "--app", "http://localhost:3999"]);
    expect(child!.spawnargs[1]).toMatch(/agent-host\/bin\/parlor-host-dev\.mjs$/);
  });

  it("is skipped with --no-agent-host or when the server signs people in itself", () => {
    expect(
      startDevAgentHost(loaded, { enabled: false, serverHasAuth: false }),
    ).toBeUndefined();
    expect(
      startDevAgentHost(loaded, { enabled: true, serverHasAuth: true }),
    ).toBeUndefined();
  });

  it("T4-13: a dev host still waiting for its server exits within 3 s of the CLI's shutdown", async () => {
    let attempts = 0;
    const silent = createServer((socket) => {
      attempts += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => silent.listen(0, resolve));
    const kill = process.kill.bind(process);
    const reraised = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) =>
        pid === process.pid ? true : kill(pid, signal),
      );
    let child: ChildProcess | undefined;
    try {
      const { port } = silent.address() as AddressInfo;
      child = startDevAgentHost(loadedOn(port), {
        enabled: true,
        serverHasAuth: false,
      })!;
      await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), {
        timeout: 15_000,
        interval: 50,
      });

      const exited = once(child, "exit").then(() => Date.now());
      const shutdownAt = Date.now();
      process.emit("SIGINT");
      const exitedAt = await Promise.race([exited, delay(EXIT_BOUND_MS + 2_000)]);
      expect(exitedAt).toBeDefined();
      expect(exitedAt! - shutdownAt).toBeLessThanOrEqual(EXIT_BOUND_MS);
    } finally {
      child?.kill("SIGKILL");
      await vi.waitFor(() =>
        expect(reraised).toHaveBeenCalledWith(process.pid, "SIGINT"),
      );
      reraised.mockRestore();
      await new Promise((resolve) => silent.close(resolve));
    }
  }, 30_000);
});
