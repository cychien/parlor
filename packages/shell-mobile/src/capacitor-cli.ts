import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FORCE_KILL_AFTER_MS = 5000;

export class CapacitorCliError extends Error {
  override readonly name = "CapacitorCliError";
}

export interface RunCapacitorOptions {
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

export function runCapacitor(
  args: readonly string[],
  options: RunCapacitorOptions,
): Promise<void> {
  const bin = require.resolve("@capacitor/cli/bin/capacitor");
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
      else
        reject(new CapacitorCliError(`cap ${args.join(" ")} exited with code ${code}`));
    });
  });
}
