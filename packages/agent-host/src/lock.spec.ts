import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { holdsLock, withFileLock, withInheritedLock } from "./lock.js";

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
      expect((await readFile(path, "utf8")).split("\n")[0]).toBe(String(process.pid));
    });
  });

  it("takes over a lock whose owner is dead", async () => {
    const path = join(dir, "dead.lock");
    await writeFile(path, `${await deadPid()}\n`);
    const started = Date.now();
    await withFileLock(path, async () => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("takes over a lock whose pid now belongs to a process that started after the lock was written", async () => {
    const path = join(dir, "reused.lock");
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      await writeFile(path, `${owner.pid}\n`);
      const written = new Date(Date.now() - 60 * 60_000);
      await utimes(path, written, written);
      const started = Date.now();
      await withFileLock(path, async () => undefined);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      owner.kill();
    }
  });

  it("never takes over a lock whose live owner started before it was written", async () => {
    const path = join(dir, "old.lock");
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      await sleep(1_100);
      await writeFile(path, `${owner.pid}\n`);
      let entered = false;
      const waiting = withFileLock(path, async () => void (entered = true));
      await sleep(300);
      expect(entered).toBe(false);
      await rm(path);
      await waiting;
      expect(entered).toBe(true);
    } finally {
      owner.kill();
    }
  });

  it("waits for a live owner", async () => {
    const path = join(dir, "live.lock");
    await writeFile(path, `${process.pid}\n`);
    let entered = false;
    const waiting = withFileLock(path, async () => void (entered = true));
    await sleep(150);
    expect(entered).toBe(false);
    await rm(path);
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

  it("names the holder with a token the lock file carries", async () => {
    const path = join(dir, "token.lock");
    await withFileLock(path, async (token) => {
      expect(await holdsLock(path, token)).toBe(true);
      expect(await holdsLock(path, "another")).toBe(false);
    });
    expect(await holdsLock(path, "anything")).toBe(false);
  });

  it("does not remove a lock that was taken over from its holder", async () => {
    const path = join(dir, "taken.lock");
    await withFileLock(path, async () => {
      await rm(path);
      await writeFile(path, `${process.pid}\nsomeone-else\n`);
    });
    expect(await holdsLock(path, "someone-else")).toBe(true);
    await rm(path);
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

describe("withInheritedLock", () => {
  it("runs under the lock its parent holds without waiting for it", async () => {
    const path = join(dir, "inherited.lock");
    await withFileLock(path, async (token) => {
      let ran = false;
      await withInheritedLock(path, token, async () => void (ran = true));
      expect(ran).toBe(true);
      expect(await holdsLock(path, token)).toBe(true);
    });
  });

  it("takes a lock of its own when the token names no held lock", async () => {
    const path = join(dir, "forged.lock");
    await writeFile(path, `${process.pid}\nreal\n`);
    let entered = false;
    const waiting = withInheritedLock(path, "forged", async () => void (entered = true));
    await sleep(150);
    expect(entered).toBe(false);
    await rm(path);
    await waiting;
    expect(entered).toBe(true);
  });

  it("takes a lock of its own when there is no token", async () => {
    const path = join(dir, "own.lock");
    await withInheritedLock(path, undefined, async () => {
      expect((await readFile(path, "utf8")).trim().split("\n")[0]).toBe(
        String(process.pid),
      );
    });
  });
});
