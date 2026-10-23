import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { GENERATED_DIR } from "@parlor/config";

import { CliError } from "./errors.js";

export interface DevSession {
  readonly pid: number;
  readonly targets: readonly string[];
  readonly urls: readonly string[];
}

export const DEV_SESSION_FILE = "dev.json";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function read(path: string): DevSession | undefined {
  try {
    const session = JSON.parse(readFileSync(path, "utf8")) as Partial<DevSession>;
    return typeof session.pid === "number"
      ? { pid: session.pid, targets: session.targets ?? [], urls: session.urls ?? [] }
      : undefined;
  } catch {
    return undefined;
  }
}

function running(owner: DevSession): string {
  const targets = owner.targets.length > 0 ? owner.targets : ["web"];
  const where = targets
    .map((target, index) =>
      owner.urls[index] ? `${target} at ${owner.urls[index]}` : target,
    )
    .join(", ");
  return `parlor dev is already running for this project (${where}, pid ${owner.pid}). A second one would open the same database. Stop it first, or run every target from one: parlor dev --target web,mac.`;
}

/**
 * Claims the project for this `parlor dev`, so a second one cannot open the same database;
 * a claim whose process is gone is stale. `update` records the URLs once the ports are known.
 */
export function claimDevSession(
  rootDir: string,
  targets: readonly string[],
  pid: number = process.pid,
): { update(urls: readonly string[]): void; release(): void } {
  const path = join(rootDir, GENERATED_DIR, DEV_SESSION_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const write = (urls: readonly string[]) => JSON.stringify({ pid, targets, urls });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, write([]));
      closeSync(fd);
      return {
        update: (urls) => writeFileSync(path, write(urls)),
        release: () => {
          if (read(path)?.pid === pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = read(path);
      if (owner && owner.pid !== pid && alive(owner.pid))
        throw new CliError(running(owner));
      rmSync(path, { force: true });
    }
  }
  throw new CliError(`Could not claim ${path} for parlor dev.`);
}
