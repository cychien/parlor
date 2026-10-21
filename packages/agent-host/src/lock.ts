import { open, readFile, rename, rm, stat } from "node:fs/promises";

export const LOCK_STALE_MS = 60_000;
const RETRY_MS = 20;
const UNWRITTEN_MS = 1_000;
const ACQUIRE_TIMEOUT_MS = 2 * LOCK_STALE_MS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stale(path: string, staleMs: number): Promise<boolean> {
  try {
    const [text, { mtimeMs }] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const age = Date.now() - mtimeMs;
    const pid = Number.parseInt(text, 10);
    if (!Number.isInteger(pid)) return age > UNWRITTEN_MS;
    return age > staleMs || !alive(pid);
  } catch {
    return false;
  }
}

async function acquire(path: string, staleMs: number): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(`${process.pid}\n`);
      await file.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await stale(path, staleMs)) {
      await rename(path, `${path}.stale.${process.pid}`).catch(() => undefined);
      await rm(`${path}.stale.${process.pid}`, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Could not take the lock ${path}.`);
    await sleep(RETRY_MS);
  }
}

/** A cross-process mutex: an `O_EXCL` file holding its owner's pid, stolen once the owner is dead or silent for `staleMs`. */
export async function withFileLock<T>(
  path: string,
  work: () => Promise<T>,
  staleMs: number = LOCK_STALE_MS,
): Promise<T> {
  await acquire(path, staleMs);
  try {
    return await work();
  } finally {
    const owner = await readFile(path, "utf8").catch(() => undefined);
    if (owner !== undefined && Number.parseInt(owner, 10) === process.pid) {
      await rm(path, { force: true });
    }
  }
}
