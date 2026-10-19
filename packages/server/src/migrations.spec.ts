import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, splitStatements } from "./migrations.js";

describe("splitStatements", () => {
  it("splits on semicolons and drops the empty tail", () => {
    expect(
      splitStatements("create table a (id text);\ncreate index a_id on a (id);\n"),
    ).toEqual(["create table a (id text)", "create index a_id on a (id)"]);
  });

  it("keeps a statement whole when it has no semicolon", () => {
    expect(splitStatements("create table a (id text)")).toEqual([
      "create table a (id text)",
    ]);
  });

  it("does not split inside quotes, comments or dollar-quoted bodies", () => {
    const body = `create table a (note text default 'x;y', "we;ird" text); -- trailing; comment
/* block; comment */ insert into a (note) values ($tag$one;two$tag$);
do $$ begin perform 1; end $$`;
    expect(splitStatements(body)).toEqual([
      `create table a (note text default 'x;y', "we;ird" text)`,
      `-- trailing; comment
/* block; comment */ insert into a (note) values ($tag$one;two$tag$)`,
      "do $$ begin perform 1; end $$",
    ]);
  });
});

describe("applyMigrations on PGlite", () => {
  let handle: DatabaseHandle;
  beforeAll(async () => {
    handle = await createDatabase({ dataDir: "memory://" });
    await handle.db.execute(sql`select 1`);
  }, 30_000);
  afterAll(async () => {
    await handle.close();
  });

  it("applies a migration made of several statements", async () => {
    await applyMigrations(handle, [
      {
        name: "demo",
        setup: () => ({}),
        migrations: [
          {
            id: "demo/0001_two_tables",
            sql: "create table demo_a (id text primary key); create table demo_b (id text primary key)",
          },
        ],
      },
    ]);
    const rows = await handle.db.execute(
      sql`select table_name from information_schema.tables where table_name in ('demo_a', 'demo_b') order by table_name`,
    );
    expect(rows.rows.map((row) => row.table_name)).toEqual(["demo_a", "demo_b"]);
  });
});
