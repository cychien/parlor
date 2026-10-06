import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FORCE_KILL_AFTER_MS = 5000;

export class TauriCliError extends Error {
  override readonly name = "TauriCliError";
}

export interface RunTauriOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

export function runTauri(
  args: readonly string[],
  options: RunTauriOptions,
): Promise<void> {
  const bin = require.resolve("@tauri-apps/cli/tauri.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd,
      stdio: "inherit",
      detached: true,
    });
    const pid = child.pid;
    const abort = () => {
      if (pid === undefined) return;
      killGroup(pid, "SIGINT");
      setTimeout(() => killGroup(pid, "SIGKILL"), FORCE_KILL_AFTER_MS).unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (code === 0 || signal || options.signal?.aborted) resolve();
      else reject(new TauriCliError(`tauri ${args[0]} exited with code ${code}`));
    });
  });
}
