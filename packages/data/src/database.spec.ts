import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle, resolveDatabaseUrl } from "./database.js";

const handles: DatabaseHandle[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

async function memoryDatabase(migrationsFolder?: string) {
  const handle = await createDatabase({ dataDir: "memory://", migrationsFolder });
  handles.push(handle);
  return handle;
}

describe("resolveDatabaseUrl", () => {
  it("reads DATABASE_URL and treats empty as unset", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
    expect(resolveDatabaseUrl({ DATABASE_URL: "" })).toBeUndefined();
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://x" })).toBe("postgres://x");
  });
});

describe("createDatabase with PGlite", () => {
  it("runs SQL, commits transactions, and rolls back on error", async () => {
    const handle = await memoryDatabase();
    expect(handle.driver).toBe("pglite");
    await handle.db.execute(sql`create table t (n int)`);

    await handle.transaction(async (tx) => {
      await tx.execute(sql`insert into t values (1)`);
    });
    await handle
      .transaction(async (tx) => {
        await tx.execute(sql`insert into t values (2)`);
        throw new Error("boom");
      })
      .catch(() => {});

    const rows = await handle.read().execute(sql`select n from t order by n`);
    expect(rows.rows).toEqual([{ n: 1 }]);
  });

  it("applies migrations from a folder on create", async () => {
    const folder = await mkdtemp(join(tmpdir(), "parlor-migrations-"));
    await writeFile(
      join(folder, "0000_init.sql"),
      "create table tasks (id text primary key);",
    );
    await import("node:fs/promises").then((fs) => fs.mkdir(join(folder, "meta")));
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true }],
      }),
    );
    const handle = await memoryDatabase(folder);
    await handle.db.execute(sql`insert into tasks values ('a')`);
    const rows = await handle.db.execute(sql`select count(*)::int as c from tasks`);
    expect(rows.rows).toEqual([{ c: 1 }]);
  });
});
