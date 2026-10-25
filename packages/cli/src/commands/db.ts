import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";

import { generatedDir, loadParlorConfig } from "@parlor/config";
import { createDatabase } from "@parlor/data";
import { defineCommand } from "citty";

import { CliError } from "../errors.js";

const require = createRequire(import.meta.url);

/** `name` replaces drizzle-kit's random suffix, so a generated migration has a stable file name. */
export function drizzleKitArgs(
  schema: string,
  migrations: string,
  name?: string,
): string[] {
  return [
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    schema,
    "--out",
    migrations,
    ...(name === undefined ? [] : ["--name", name]),
  ];
}

const STACK_FRAME = /^\s+at \S/m;

const KILL_GRACE_MS = 2000;
const PARENT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface DrizzleKitOptions {
  readonly stdout?: "inherit" | "ignore";
  readonly stderr?: Writable;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export function runDrizzleKit(
  args: readonly string[],
  cwd: string,
  options: DrizzleKitOptions = {},
): Promise<void> {
  const { stdout = "inherit", stderr = process.stderr, signal, timeoutMs } = options;
  const command = `drizzle-kit ${args[0]}`;
  const bin = join(dirname(require.resolve("drizzle-kit")), "bin.cjs");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CliError(`${command} aborted`));
      return;
    }
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      // the rename prompt needs a TTY; without one stdin would only keep the child waiting
      stdio: [process.stdin.isTTY ? "inherit" : "ignore", stdout, "pipe"],
    });
    let stderrText = "";
    let stopReason: CliError | undefined;
    let parentSignal: NodeJS.Signals | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = (reason: CliError) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => stop(new CliError(`${command} aborted`));
    const onParentExit = () => {
      child.kill("SIGKILL");
    };
    const onParentSignal = (name: NodeJS.Signals) => {
      parentSignal = name;
      stop(new CliError(`${command} interrupted by ${name}`));
    };
    const timeoutTimer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => stop(new CliError(`${command} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );

    signal?.addEventListener("abort", onAbort, { once: true });
    process.once("exit", onParentExit);
    for (const name of PARENT_SIGNALS) process.on(name, onParentSignal);
    const release = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      process.removeListener("exit", onParentExit);
      for (const name of PARENT_SIGNALS) process.removeListener(name, onParentSignal);
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString();
      stderr.write(chunk);
    });
    child.once("error", (error) => {
      release();
      reject(error);
    });
    child.once("close", (code) => {
      release();
      if (stopReason) reject(stopReason);
      else if (code !== 0)
        reject(new CliError(`${command} failed with exit code ${code}`));
      // drizzle-kit catches its own errors, prints the Error to stderr and still exits 0
      else if (STACK_FRAME.test(stderrText)) reject(new CliError(`${command} failed`));
      else resolve();
      if (parentSignal) process.kill(process.pid, parentSignal);
    });
  });
}

const generate = defineCommand({
  meta: { name: "generate", description: "Generate a SQL migration from the schema" },
  args: {
    name: {
      type: "string",
      description: "Name of the migration file instead of a random one",
    },
  },
  async run({ args }) {
    const { config, rootDir } = await loadParlorConfig();
    await runDrizzleKit(
      drizzleKitArgs(config.database.schema, config.database.migrations, args.name),
      rootDir,
    );
  },
});

const migrate = defineCommand({
  meta: { name: "migrate", description: "Apply pending migrations to the database" },
  async run() {
    const { config, rootDir } = await loadParlorConfig();
    const database = await createDatabase({
      dataDir: join(generatedDir(rootDir), "pglite"),
    });
    try {
      await database.migrate(join(rootDir, config.database.migrations));
      console.log(`migrations applied with ${database.driver}`);
    } finally {
      await database.close();
    }
  },
});

export const db = defineCommand({
  meta: { name: "db", description: "Database migrations" },
  subCommands: { generate, migrate },
});
