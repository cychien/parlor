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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("runDrizzleKit", () => {
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
    await rm(projectDir, { recursive: true, force: true });
  });

  const generate = () =>
    runDrizzleKit(drizzleKitArgs("schema", "migrations"), projectDir, {
      stdout: "ignore",
      stderr,
    });

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
});
