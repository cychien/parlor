import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle, migrateOnPrepare } from "./database.js";
import { migrationsIn } from "./migrations.js";
import * as workerd from "./platform.workerd.js";

const globals = globalThis as { __PARLOR_MIGRATIONS__?: unknown };

async function migrationsFolder(statement: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "parlor-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "0000_init.sql"), statement);
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true }],
    }),
  );
  return folder;
}

let pglite: DatabaseHandle;

// PGlite starts on its first query and that is the slow part, so it happens once, outside any test's timeout.
beforeAll(async () => {
  pglite = await createDatabase({ dataDir: "memory://" });
  await pglite.db.execute(sql`select 1`);
}, 30_000);

afterAll(async () => {
  await pglite.close();
});

afterEach(() => {
  delete globals.__PARLOR_MIGRATIONS__;
});

describe("migrations embedded in a build", () => {
  it("are applied without reading the folder, exactly as drizzle reads them", async () => {
    const folder = await migrationsFolder("create table embedded (n int);");
    globals.__PARLOR_MIGRATIONS__ = {
      migrations: readMigrationFiles({ migrationsFolder: folder }),
    };
    await pglite.migrate("migrations");
    const rows = await pglite.db.execute(sql`select count(*)::int as n from embedded`);
    expect(rows.rows).toEqual([{ n: 0 }]);
  });

  it("name the config field when the requested folder was not embedded", () => {
    globals.__PARLOR_MIGRATIONS__ = { migrations: [] };
    expect(() => migrationsIn("db/migrations")).toThrow(/database\.migrations/);
  });

  it("are read from the folder when the build embedded none", async () => {
    const folder = await migrationsFolder("create table read (n int);");
    expect(migrationsIn(folder)).toHaveLength(1);
  });
});

describe("migrations deferred to the first request", () => {
  it("run once, and run again after a failed attempt instead of failing for good", async () => {
    let calls = 0;
    const flaky = {
      ...pglite,
      migrate: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
      },
    };
    const handle = migrateOnPrepare(flaky, "migrations");
    await expect(handle.prepare!()).rejects.toThrow("connection reset");
    await handle.prepare!();
    await handle.prepare!();
    expect(calls).toBe(2);
  });
});

describe("the workerd platform", () => {
  it("loads without DATABASE_URL, and says it is missing on every use", async () => {
    const handle = await workerd.pgliteHandle();
    const db = handle.db;
    expect(() => db.select).toThrow(/DATABASE_URL is not set/);
    expect(() => handle.read()).toThrow(/DATABASE_URL/);
    await expect(handle.migrate("migrations")).rejects.toThrow(/DATABASE_URL/);
    await expect(handle.transaction(async () => 1)).rejects.toThrow(/DATABASE_URL/);
    await expect(handle.client.query("select 1")).rejects.toThrow(/DATABASE_URL/);
  });

  it("leaves migrations to prepare, since no I/O may run while the app loads", () => {
    expect(workerd.migratesWhileLoading).toBe(false);
  });
});
