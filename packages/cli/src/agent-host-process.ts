import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { LoadedConfig } from "@parlor/config";

import { stopServerProcess } from "./server-process.js";
import { onShutdown } from "./shutdown.js";

const require = createRequire(import.meta.url);

export interface DevAgentHostOptions {
  /** `--no-agent-host` turns it off. */
  readonly enabled: boolean;
  /** The server is running with its own auth provider, so `devAuth` is not there to pair with. */
  readonly serverHasAuth: boolean;
}

/** The `parlor-host` entry of the installed `@parlor/agent-host`. */
function agentHostBin(): string {
  return join(
    dirname(require.resolve("@parlor/agent-host")),
    "..",
    "bin",
    "parlor-host-dev.mjs",
  );
}

/**
 * `parlor dev` runs `parlor-host dev --app http://localhost:<port>` next to the server, so
 * the chat works against the developer's own agents with no pairing. Orchestration only;
 * `undefined` when skipped. The host waits for the server, and leaves quietly when the
 * app turns out to sign people in itself.
 */
export function startDevAgentHost(
  { config, rootDir }: LoadedConfig,
  options: DevAgentHostOptions,
): ChildProcess | undefined {
  if (!options.enabled || options.serverHasAuth) return undefined;
  const child = spawn(
    process.execPath,
    [agentHostBin(), "dev", "--app", `http://localhost:${config.server.port}`],
    { cwd: rootDir, stdio: "inherit", env: process.env },
  );
  onShutdown(() => stopServerProcess(child));
  return child;
}
