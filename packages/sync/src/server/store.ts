import type { Tag } from "@parlor/core";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  compareCursors,
  type SyncCursor,
  type SyncEvent,
  SYNC_CHANNEL,
} from "../protocol.js";

export type SyncDatabase = PgDatabase<PgQueryResultHKT>;

export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const PRUNE_LOCK_KEY = 7_311_207;
const MAX_BATCH = 500;

async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  const result = (await query) as { rows?: T[] } | T[];
  return Array.isArray(result) ? result : (result.rows ?? []);
}

export async function ensureSyncTables(db: SyncDatabase): Promise<void> {
  await db.execute(sql`
    create table if not exists sync_events (
      id text primary key,
      version bigint not null,
      scope text not null,
      tags jsonb not null,
      source text,
      created_at timestamptz not null default clock_timestamp()
    )`);
  await db.execute(
    sql`create index if not exists sync_events_scope_version on sync_events (scope, version, id)`,
  );
  await db.execute(
    sql`create table if not exists sync_version (id int primary key, v bigint not null)`,
  );
  await db.execute(sql`
    insert into sync_version (id, v)
    select 1, greatest(coalesce((select max(version) from sync_events), 0), 0)
    on conflict (id) do nothing`);
}

export interface RecordSyncEventInput {
  readonly scope: string;
  readonly tags: readonly Tag[];
  readonly source?: string | undefined;
}

export async function recordSyncEvent(
  tx: SyncDatabase,
  input: RecordSyncEventInput,
): Promise<SyncEvent> {
  if (input.tags.length === 0) throw new Error("A sync event needs at least one tag");
  const id = crypto.randomUUID();
  const tags = JSON.stringify(input.tags);
  const inserted = await rows<{ version: number | string }>(
    tx.execute(sql`
      with alloc as (
        update sync_version
           set v = greatest(v + 1, (extract(epoch from clock_timestamp()) * 1000)::bigint)
         where id = 1
         returning v
      )
      insert into sync_events (id, version, scope, tags, source)
      select ${id}, alloc.v, ${input.scope}, ${tags}::jsonb, ${input.source ?? null}
        from alloc
      returning version`),
  );
  const row = inserted[0];
  if (!row) throw new Error("sync_version row is missing; run ensureSyncTables first");
  const event: SyncEvent = {
    version: Number(row.version),
    id,
    tags: input.tags,
    source: input.source,
  };
  const payload = JSON.stringify({ scope: input.scope, event });
  await tx.execute(sql`select pg_notify(${SYNC_CHANNEL}, ${payload})`);
  return event;
}

interface EventRow {
  id: string;
  version: number | string;
  tags: Tag[];
  source: string | null;
}

export async function readSyncEvents(
  db: SyncDatabase,
  scope: string,
  since: SyncCursor,
  limit: number = MAX_BATCH,
): Promise<SyncEvent[]> {
  const found = await rows<EventRow>(
    db.execute(sql`
      select id, version, tags, source
        from sync_events
       where scope = ${scope}
         and (version > ${since.version} or (version = ${since.version} and id > ${since.id}))
       order by version asc, id asc
       limit ${limit}`),
  );
  return found
    .map((row) => ({
      id: row.id,
      version: Number(row.version),
      tags: row.tags,
      source: row.source ?? undefined,
    }))
    .sort((a, b) => compareCursors(a, b));
}

export async function pruneSyncEvents(
  db: SyncDatabase,
  retentionMs: number = RETENTION_MS,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [lock] = await rows<{ held: boolean }>(
      tx.execute(sql`select pg_try_advisory_xact_lock(${PRUNE_LOCK_KEY}) as held`),
    );
    if (!lock?.held) return 0;
    const cutoff = new Date(Date.now() - retentionMs);
    const deleted = await rows<{ id: string }>(
      tx.execute(sql`delete from sync_events where created_at < ${cutoff} returning id`),
    );
    return deleted.length;
  });
}

export interface NotifyPayload {
  readonly scope: string;
  readonly event: SyncEvent;
}

export function parseNotifyPayload(payload: string): NotifyPayload | undefined {
  try {
    const parsed = JSON.parse(payload) as Partial<NotifyPayload>;
    if (typeof parsed.scope !== "string" || !parsed.event) return undefined;
    return { scope: parsed.scope, event: parsed.event };
  } catch {
    return undefined;
  }
}
