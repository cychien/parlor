import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { LoadedConfig } from "@parlor/config";

import { CliError } from "./errors.js";
import { stopServerProcess } from "./server-process.js";
import { onShutdown } from "./shutdown.js";

const require = createRequire(import.meta.url);

export interface DevAgentHostOptions {
  /** `--no-agent-host` turns it off. */
  readonly enabled: boolean;
  /** The server is running with its own auth provider, so `devAuth` is not there to pair with. */
  readonly serverHasAuth: boolean;
}

export const AGENT_HOST_BIN = "parlor-host";

/**
 * The `parlor-host` bin as the installed manifest declares it: `bin/parlor-host-dev.mjs` (tsx on
 * `src/`) in the repo, `dist/main.js` once `publishConfig` is applied. Resolving the exported
 * `package.json` works under CJS resolution, which the package's `import`-only entry does not.
 */
export function agentHostBin(): string {
  const manifestPath = require.resolve("@parlor/agent-host/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly bin?: Readonly<Record<string, string>>;
  };
  const bin = manifest.bin?.[AGENT_HOST_BIN];
  if (!bin) throw new CliError(`@parlor/agent-host has no ${AGENT_HOST_BIN} bin`);
  return join(dirname(manifestPath), bin);
}

/**
 * `parlor dev` runs `parlor-host dev --app http://localhost:<port>` next to the server, so
 * the chat works against the developer's own agents with no pairing. Orchestration only;
 * `undefined` when skipped.
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
  onShutdown((signaled) => stopServerProcess(child, signaled ? undefined : 0));
  return child;
}
