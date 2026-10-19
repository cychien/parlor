import type { DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CHAT_MIGRATIONS } from "./migrations.js";
import { drivers, openDatabase, resetDatabase, rows, serveChat } from "./spec-kit.js";

describe("chat/0001_threads", () => {
  it("is a single statement, because PGlite prepares every query", () => {
    expect(CHAT_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "chat/0001_threads",
    ]);
    const [migration] = CHAT_MIGRATIONS;
    expect(migration?.sql.trim().startsWith("do $migration$ begin")).toBe(true);
    expect(migration?.sql.trim().endsWith("end $migration$")).toBe(true);
  });
});

describe.each(drivers)("applying chat/0001_threads on $name", (driver) => {
  let handle: DatabaseHandle;
  beforeAll(async () => {
    handle = await openDatabase(driver);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  it("applies over a database that already holds earlier plugins' migrations, once", async () => {
    await resetDatabase(handle);
    await handle.db.execute(
      sql`create table parlor_migrations (id text primary key, applied_at timestamptz not null default now())`,
    );
    await handle.db.execute(
      sql`insert into parlor_migrations (id) values ('auth/0001_revocations'), ('auth/0002_revocations_revoked_at')`,
    );
    for (let start = 0; start < 2; start += 1) {
      const app = serveChat(handle);
      const reply = await app.action("alice", "hosts", {});
      expect(reply.status).toBe(200);
      await app.server.close();
    }
    expect(await rows(handle, "select id from parlor_migrations order by id")).toEqual([
      { id: "auth/0001_revocations" },
      { id: "auth/0002_revocations_revoked_at" },
      { id: "chat/0001_threads" },
    ]);
    expect(
      await rows(
        handle,
        "select tablename from pg_tables where tablename like 'parlor_chat_%' order by tablename",
      ),
    ).toEqual([
      { tablename: "parlor_chat_hosts" },
      { tablename: "parlor_chat_items" },
      { tablename: "parlor_chat_threads" },
      { tablename: "parlor_chat_turns" },
    ]);
  });
});
