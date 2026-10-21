import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";

export const LOCK_TOKEN_ENV = "PARLOR_HOST_LOCK_TOKEN";
const RETRY_MS = 20;
const UNWRITTEN_MS = 1_000;
const ACQUIRE_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stale(path: string): Promise<boolean> {
  try {
    const [text, { mtimeMs }] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const age = Date.now() - mtimeMs;
    const pid = Number.parseInt(text, 10);
    if (!Number.isInteger(pid)) return age > UNWRITTEN_MS;
    return !alive(pid);
  } catch {
    return false;
  }
}

async function acquire(path: string, token: string): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(`${process.pid}\n${token}\n`);
      await file.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await stale(path)) {
      await rename(path, `${path}.stale.${process.pid}`).catch(() => undefined);
      await rm(`${path}.stale.${process.pid}`, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Could not take the lock ${path}.`);
    await sleep(RETRY_MS);
  }
}

const tokenOf = (text: string): string | undefined => text.split("\n")[1];

export async function holdsLock(path: string, token: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text !== undefined && tokenOf(text) === token;
}

/** A lock is held until its owner process dies; there is no age-based takeover. */
export async function withFileLock<T>(
  path: string,
  work: (token: string) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  await acquire(path, token);
  try {
    return await work(token);
  } finally {
    if (await holdsLock(path, token)) await rm(path, { force: true });
  }
}

/** Runs `work` under the lock `inherited` names when this process's parent holds it, else under a lock of its own. */
export async function withInheritedLock<T>(
  path: string,
  inherited: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (inherited && (await holdsLock(path, inherited))) return work();
  return withFileLock(path, work);
}
