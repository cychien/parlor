import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { LoadedConfig, ParlorConfig } from "@parlor/config";

import { onShutdown } from "./shutdown.js";

const require = createRequire(import.meta.url);

export function serverEnv(
  config: ParlorConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PORT: String(config.server.port),
    PARLOR_WEB_ORIGIN: `http://localhost:${config.web.port}`,
    PARLOR_APP_NAME: config.app.name,
  };
}

export const SERVER_SELF_EXIT_GRACE_MS = 2000;

// A second signal makes tsx watch SIGKILL its child, and the process group usually delivered the first.
export async function stopServerProcess(
  child: ChildProcess,
  graceMs: number = SERVER_SELF_EXIT_GRACE_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const nudge = setTimeout(() => child.kill("SIGTERM"), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(nudge);
  }
}

export function startServerProcess({ config, rootDir }: LoadedConfig): ChildProcess {
  const tsxBin = require.resolve("tsx/cli");
  const runner = new URL("./serve-entry.ts", import.meta.url).pathname.replace(
    /\.ts$/,
    import.meta.url.endsWith(".js") ? ".js" : ".ts",
  );
  const entry = join(rootDir, config.server.entry);
  const child = spawn(process.execPath, [tsxBin, "watch", runner, entry], {
    cwd: rootDir,
    stdio: "inherit",
    env: serverEnv(config),
  });
  onShutdown(() => stopServerProcess(child));
  return child;
}
