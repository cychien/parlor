import type { DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CHAT_MIGRATIONS } from "./migrations.js";
import { drivers, openDatabase, resetDatabase, rows, serveChat } from "./spec-kit.js";

describe("chat/0001_threads", () => {
  it("is one migration of plain statements", () => {
    expect(CHAT_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "chat/0001_threads",
    ]);
    expect(CHAT_MIGRATIONS[0]?.sql).not.toContain("$");
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

describe.each(drivers)("the indexes of chat/0001_threads on $name", (driver) => {
  let handle: DatabaseHandle;
  beforeAll(async () => {
    handle = await openDatabase(driver);
    await resetDatabase(handle);
    const app = serveChat(handle);
    await app.action("alice", "hosts", {});
    await app.server.close();
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  const definitionOf = async (name: string) =>
    (
      await rows(handle, `select indexdef from pg_indexes where indexname = '${name}'`)
    ).map((row) => (row as { indexdef: string }).indexdef);

  it("serves the queue count and the claim's earlier-turn check by thread and state", async () => {
    expect(await definitionOf("parlor_chat_turns_thread_state")).toEqual([
      "CREATE INDEX parlor_chat_turns_thread_state ON public.parlor_chat_turns USING btree (thread_id, state)",
    ]);
  });

  it("serves the lapsed lease scan by lease time", async () => {
    expect(await definitionOf("parlor_chat_turns_lease")).toEqual([
      "CREATE INDEX parlor_chat_turns_lease ON public.parlor_chat_turns USING btree (lease_until) WHERE (state = 'running'::text)",
    ]);
  });

  it("serves the lapsed computer scan by liveness time", async () => {
    expect(await definitionOf("parlor_chat_hosts_lapse")).toEqual([
      "CREATE INDEX parlor_chat_hosts_lapse ON public.parlor_chat_hosts USING btree (online_until) WHERE announced_online",
    ]);
  });
});
