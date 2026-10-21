// One machine-wide lock for the host's local macOS dialogs. A script holds it while it finds a
// dialog and acts on it, so scripts running at once never read or click each other's dialog.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DIALOG_LOCK = join(
  homedir(),
  ".cache",
  "parlor-verify-hello",
  "dialog.lock",
);
export const DIALOG_LOCK_MS = 120_000;

const held = new AsyncLocalStorage();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function holderOf(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function tryTake(path) {
  const mine = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now() }));
  try {
    linkSync(mine, path);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  } finally {
    unlinkSync(mine);
  }
}

// Renaming the lock away first means two scripts reaping one dead holder cannot both delete it.
function reapIfDead(path) {
  const holder = holderOf(path);
  let stale;
  if (holder) stale = !alive(holder.pid);
  else {
    try {
      stale = Date.now() - statSync(path).mtimeMs > 5_000;
    } catch {
      return;
    }
  }
  if (!stale) return;
  const reaped = `${path}.reaped.${process.pid}`;
  try {
    renameSync(path, reaped);
    unlinkSync(reaped);
  } catch {}
}

async function acquire(path, timeoutMs) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryTake(path)) return;
    reapIfDead(path);
    if (Date.now() >= deadline) {
      const holder = holderOf(path);
      throw new Error(
        `dialog lock ${path} still held${holder ? ` by pid ${holder.pid} since ${new Date(holder.at).toISOString()}` : ""} after ${timeoutMs} ms; another script is answering a local dialog`,
      );
    }
    await wait(50 + Math.random() * 100);
  }
}

function release(path) {
  if (holderOf(path)?.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {}
}

/**
 * Runs `fn` holding the machine-wide dialog lock: exclusive across scripts and across the async
 * tasks of this one, re-entrant inside `fn`. The lock dies with its process (a holder whose pid
 * is gone is taken over). Waiting is bounded by `timeoutMs`, then it throws.
 */
export async function withDialogLock(
  fn,
  { path = DIALOG_LOCK, timeoutMs = DIALOG_LOCK_MS } = {},
) {
  if (held.getStore()?.has(path)) return fn();
  await acquire(path, timeoutMs);
  try {
    return await held.run(new Set([...(held.getStore() ?? []), path]), fn);
  } finally {
    release(path);
  }
}
