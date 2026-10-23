import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drizzleKitArgs, runDrizzleKit } from "./db.js";

describe("drizzleKitArgs", () => {
  it("passes the configured schema and migrations folders relative to the project root", () => {
    expect(drizzleKitArgs("schema", "migrations")).toEqual([
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      "schema",
      "--out",
      "migrations",
    ]);
  });
});

const tasksSchema = (columns: string) => `
import { pgTable, text } from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),${columns}
});
`;

const GENERATE_TIMEOUT_MS = 30_000;

const hangingSchema = (pidFile: string) => `
import { writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
export {};
`;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runDrizzleKit", { timeout: GENERATE_TIMEOUT_MS }, () => {
  let projectDir: string;
  let stderrText: string;
  const stderr = new Writable({
    write(chunk: Buffer, _encoding, done) {
      stderrText += chunk.toString();
      done();
    },
  });

  beforeEach(async () => {
    stderrText = "";
    projectDir = await mkdtemp(join(tmpdir(), "parlor-db-"));
    await symlink(
      join(import.meta.dirname, "../../node_modules"),
      join(projectDir, "node_modules"),
    );
    await mkdir(join(projectDir, "schema"));
  });

  afterEach(async () => {
    const leaked = await readPid().catch(() => undefined);
    if (leaked !== undefined && isAlive(leaked)) process.kill(leaked, "SIGKILL");
    await rm(projectDir, { recursive: true, force: true });
  });

  const generate = (extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    runDrizzleKit(drizzleKitArgs("schema", "migrations"), projectDir, {
      stdout: "ignore",
      stderr,
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      ...extra,
    });

  const pidFile = () => join(projectDir, "drizzle-kit.pid");
  const readPid = async () => Number(await readFile(pidFile(), "utf8"));
  const startedPid = () => vi.waitFor(readPid, { timeout: 10_000, interval: 50 });
  const expectGone = (pid: number) =>
    vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000, interval: 50 });
  const settle = (run: Promise<void>) =>
    run.then(
      () => undefined,
      (error: unknown) => error,
    );
  const hang = () =>
    writeFile(join(projectDir, "schema", "tasks.ts"), hangingSchema(pidFile()));

  it("generates a second migration once the schema gains a column", async () => {
    const schemaFile = join(projectDir, "schema", "tasks.ts");
    await writeFile(schemaFile, tasksSchema(""));
    await generate();

    await writeFile(schemaFile, tasksSchema(`\n  note: text("note"),`));
    await generate();

    const sqlFiles = (await readdir(join(projectDir, "migrations"))).filter((file) =>
      file.endsWith(".sql"),
    );
    expect(sqlFiles).toHaveLength(2);
    const second = await readFile(
      join(projectDir, "migrations", sqlFiles.sort()[1]!),
      "utf8",
    );
    expect(second).toContain('ADD COLUMN "note" text');
  });

  it("still succeeds when the node runtime writes its own notes to stderr", async () => {
    await writeFile(join(projectDir, "schema", "tasks.ts"), tasksSchema(""));
    const inherited = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--inspect=0";
    try {
      await generate();
    } finally {
      if (inherited === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = inherited;
    }

    expect(stderrText).toContain("Debugger listening");
    const sqlFiles = (await readdir(join(projectDir, "migrations"))).filter((file) =>
      file.endsWith(".sql"),
    );
    expect(sqlFiles).toHaveLength(1);
  });

  it("rejects when drizzle-kit fails on an unreadable schema", async () => {
    await writeFile(
      join(projectDir, "schema", "tasks.ts"),
      tasksSchema("\n  broken: text(,"),
    );

    await expect(generate()).rejects.toThrow("drizzle-kit generate failed");
    expect(stderrText).toContain("Unexpected");
  });

  it("stops drizzle-kit when the abort signal fires", async () => {
    await hang();
    const controller = new AbortController();
    const outcome = settle(generate({ signal: controller.signal }));
    const pid = await startedPid();

    controller.abort();

    expect(await outcome).toBeInstanceOf(Error);
    await expectGone(pid);
  });

  it("stops drizzle-kit that outlives the timeout", async () => {
    await hang();
    const outcome = settle(generate({ timeoutMs: 3000 }));

    expect(await outcome).toMatchObject({
      message: "drizzle-kit generate timed out after 3000ms",
    });
    await expectGone(await startedPid());
  });

  describe("when the process that runs it ends", () => {
    const harness = (cliDir: string) => `
import { existsSync } from "node:fs";

import { drizzleKitArgs, runDrizzleKit } from ${JSON.stringify(join(cliDir, "db.ts"))};

const run = runDrizzleKit(drizzleKitArgs("schema", "migrations"), process.cwd(), {
  stdout: "ignore",
  stderr: process.stderr,
});
if (process.argv[2] === "exit") {
  while (!existsSync(process.argv[3]!)) await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(3);
}
await run;
`;

    const runHarness = async (...args: string[]) => {
      await hang();
      await writeFile(join(projectDir, "harness.mts"), harness(import.meta.dirname));
      return spawn(process.execPath, ["--import", "tsx", "harness.mts", ...args], {
        cwd: projectDir,
        stdio: "ignore",
      });
    };

    const ended = (child: ReturnType<typeof spawn>) =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );

    it.each(["SIGINT", "SIGTERM"] as const)(
      "stops drizzle-kit on %s",
      async (name) => {
        const child = await runHarness();
        const exit = ended(child);
        const pid = await startedPid();

        child.kill(name);

        expect(await exit).toEqual({ code: null, signal: name });
        await expectGone(pid);
      },
      30_000,
    );

    it("stops drizzle-kit when it exits", async () => {
      const child = await runHarness("exit", pidFile());
      const exit = ended(child);

      expect(await exit).toEqual({ code: 3, signal: null });
      await expectGone(await readPid());
    });
  });
});
