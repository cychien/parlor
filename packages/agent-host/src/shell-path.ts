import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MARK = "__PARLOR_PATH__";
const TIMEOUT_MS = 3_000;

let resolved: Promise<string> | undefined;

const wellKnownDirectories = () => [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

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
 * then the directories agent CLIs install into, since a LaunchAgent or a GUI app gets only
 * launchd's system PATH.
 */
export function agentPath(): Promise<string> {
  resolved ??= fromLoginShell().then((login) => {
    const own = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const known = (entry: string) => own.includes(entry);
    const fromShell = (login ?? "")
      .split(delimiter)
      .filter((entry) => entry && !known(entry));
    const rest = [...own, ...fromShell];
    const installed = wellKnownDirectories().filter((entry) => !rest.includes(entry));
    return [...rest, ...installed].join(delimiter);
  });
  return resolved;
}

/** The first executable `name` on `path`, as an absolute path. */
export async function resolveBinary(
  name: string,
  path: string,
): Promise<string | undefined> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    const found = await access(candidate, constants.X_OK).then(
      () => candidate,
      () => undefined,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function agentEnvironment(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("PARLOR_")) env[name] = value;
  }
  env.PATH = await agentPath();
  return env;
}
