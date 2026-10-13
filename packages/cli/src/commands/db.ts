import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { loadParlorConfig } from "@parlor/config";
import { createDatabase } from "@parlor/data";
import { defineCommand } from "citty";

import { CliError } from "../errors.js";

const require = createRequire(import.meta.url);

export function drizzleKitArgs(
  rootDir: string,
  schema: string,
  migrations: string,
): string[] {
  return [
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    join(rootDir, schema),
    "--out",
    join(rootDir, migrations),
  ];
}

function runDrizzleKit(args: readonly string[], cwd: string): Promise<void> {
  const bin = join(dirname(require.resolve("drizzle-kit")), "bin.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: "inherit" });
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
      drizzleKitArgs(rootDir, config.database.schema, config.database.migrations),
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
