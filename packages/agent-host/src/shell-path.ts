import { spawn } from "node:child_process";
import { delimiter } from "node:path";

const MARK = "__PARLOR_PATH__";
const TIMEOUT_MS = 3_000;

let resolved: Promise<string> | undefined;

function fromLoginShell(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const child = spawn(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TIMEOUT_MS,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.once("error", () => resolve(undefined));
    child.once("close", () => resolve(out.split(MARK)[1]));
  });
}

/**
 * The PATH agents are found on: this process's own first, then what the login shell adds,
 * since a LaunchAgent or a GUI app does not inherit the shell's PATH.
 */
export function agentPath(): Promise<string> {
  resolved ??= fromLoginShell().then((login) => {
    const own = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const extra = (login ?? "")
      .split(delimiter)
      .filter((entry) => entry && !own.includes(entry));
    return [...own, ...extra].join(delimiter);
  });
  return resolved;
}

export async function agentEnvironment(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("PARLOR_")) env[name] = value;
  }
  env.PATH = await agentPath();
  return env;
}
