import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCK_STALE_MS, withFileLock } from "./lock.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-lock-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

describe("withFileLock", () => {
  it("runs one holder at a time and removes the lock file after", async () => {
    const path = join(dir, "serial.lock");
    const order: string[] = [];
    const hold = (name: string, ms: number) =>
      withFileLock(path, async () => {
        order.push(`${name} in`);
        await sleep(ms);
        order.push(`${name} out`);
      });
    await Promise.all([hold("a", 60), hold("b", 10)]);
    expect(order).toHaveLength(4);
    expect(order[0]!.slice(0, 1)).toBe(order[1]!.slice(0, 1));
    expect(await readFile(path, "utf8").catch(() => "gone")).toBe("gone");
  });

  it("writes the owner's pid into the lock", async () => {
    const path = join(dir, "pid.lock");
    await withFileLock(path, async () => {
      expect((await readFile(path, "utf8")).trim()).toBe(String(process.pid));
    });
  });

  it("takes over a lock whose owner is dead", async () => {
    const path = join(dir, "dead.lock");
    await writeFile(path, `${await deadPid()}\n`);
    const started = Date.now();
    await withFileLock(path, async () => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("takes over a lock its live owner has held longer than the stale limit", async () => {
    const path = join(dir, "old.lock");
    await writeFile(path, `${process.pid}\n`);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    await utimes(path, old, old);
    const started = Date.now();
    await withFileLock(path, async () => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("waits for a live owner that is still within the stale limit", async () => {
    const path = join(dir, "live.lock");
    await writeFile(path, `${process.pid}\n`);
    let entered = false;
    const waiting = withFileLock(path, async () => void (entered = true));
    await sleep(150);
    expect(entered).toBe(false);
    await utimes(path, new Date(0), new Date(0));
    await waiting;
    expect(entered).toBe(true);
  });

  it("does not take a lock whose owner has not written its pid yet", async () => {
    const path = join(dir, "unwritten.lock");
    await writeFile(path, "");
    let entered = false;
    const waiting = withFileLock(path, async () => void (entered = true));
    await sleep(150);
    expect(entered).toBe(false);
    await waiting;
    expect(entered).toBe(true);
  });

  it("T6-02: keeps two processes' read-modify-writes of one file from overwriting each other", async () => {
    const counter = join(dir, "counter.json");
    const here = fileURLToPath(new URL("./json-file.ts", import.meta.url));
    const script = `
      import { jsonFile } from ${JSON.stringify(here)};
      const file = jsonFile(${JSON.stringify(counter)});
      for (let i = 0; i < 15; i += 1) await file.change((all) => { all.n = (all.n ?? 0) + 1; });
    `;
    const run = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" },
        );
        child.once("exit", resolve);
      });
    expect(await Promise.all([run(), run(), run()])).toEqual([0, 0, 0]);
    expect(JSON.parse(await readFile(counter, "utf8"))).toEqual({ n: 45 });
  }, 60_000);
});
