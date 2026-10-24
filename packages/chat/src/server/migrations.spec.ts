import type { DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CHAT_MIGRATIONS } from "./migrations.js";
import { drivers, openDatabase, resetDatabase, rows, serveChat } from "./spec-kit.js";

describe("chat migrations", () => {
  it("are plain statements, in order", () => {
    expect(CHAT_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "chat/0001_threads",
      "chat/0002_answer_retry",
      "chat/0003_host_devices",
    ]);
    for (const migration of CHAT_MIGRATIONS) expect(migration.sql).not.toContain("$");
  });
});

describe.each(drivers)("applying the chat migrations on $name", (driver) => {
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
      { id: "chat/0002_answer_retry" },
      { id: "chat/0003_host_devices" },
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

describe.each(drivers)("the indexes of the chat migrations on $name", (driver) => {
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

  it("serves the answers to a question by plain index, so a rejected one can be answered again", async () => {
    expect(await definitionOf("parlor_chat_items_one_answer")).toEqual([]);
    expect(await definitionOf("parlor_chat_items_answers")).toEqual([
      "CREATE INDEX parlor_chat_items_answers ON public.parlor_chat_items USING btree (thread_id, ((body ->> 'askId'::text))) WHERE (kind = 'answer'::text)",
    ]);
  });
});
