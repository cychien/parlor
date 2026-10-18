import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";

import { loadParlorConfig } from "@parlor/config";
import { createDatabase } from "@parlor/data";
import { defineCommand } from "citty";

import { CliError } from "../errors.js";

const require = createRequire(import.meta.url);

export function drizzleKitArgs(schema: string, migrations: string): string[] {
  const root = process.cwd();
  return [
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    join(root, schema),
    "--out",
    join(root, migrations),
  ];
}

export interface DrizzleKitIo {
  readonly stdout: "inherit" | "ignore";
  readonly stderr: Writable;
}

export function runDrizzleKit(
  args: readonly string[],
  cwd: string,
  io: DrizzleKitIo = { stdout: "inherit", stderr: process.stderr },
): Promise<void> {
  const bin = join(dirname(require.resolve("drizzle-kit")), "bin.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: ["inherit", io.stdout, "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => io.stderr.write(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`drizzle-kit ${args[0]} exited with code ${code}`));
    });
  });
}

const generate = defineCommand({
  meta: { name: "generate", description: "Generate a SQL migration from the schema" },
  async run() {
    const { config, rootDir } = await loadParlorConfig();
    await runDrizzleKit(
      drizzleKitArgs(config.database.schema, config.database.migrations),
      rootDir,
    );
  },
});

const migrate = defineCommand({
  meta: { name: "migrate", description: "Apply pending migrations to the database" },
  async run() {
    const { config, rootDir } = await loadParlorConfig();
    const database = await createDatabase({
      dataDir: join(rootDir, ".parlor", "pglite"),
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
