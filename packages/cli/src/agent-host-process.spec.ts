import type { ChildProcess } from "node:child_process";

import { parseConfig } from "@parlor/config";
import { afterEach, describe, expect, it } from "vitest";

import { startDevAgentHost } from "./agent-host-process.js";

const loaded = {
  config: parseConfig({
    app: { id: "dev.parlor.test", name: "Test" },
    server: { port: 3999 },
  }),
  rootDir: process.cwd(),
  configFile: "parlor.config.ts",
};

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
});
