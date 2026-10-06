import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { LoadedConfig } from "@parlor/config";

import { onShutdown } from "./shutdown.js";

const require = createRequire(import.meta.url);

export function startServerProcess({ config, rootDir }: LoadedConfig): ChildProcess {
  const tsxBin = require.resolve("tsx/cli");
  const entry = join(rootDir, config.server.entry);
  const child = spawn(process.execPath, [tsxBin, "watch", entry], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, PORT: String(config.server.port) },
  });
  onShutdown(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  return child;
}
