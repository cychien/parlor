import type { Tag } from "@parlor/core";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  compareCursors,
  INITIAL_CURSOR,
  type SyncCursor,
  type SyncEvent,
  SYNC_CHANNEL,
} from "../protocol.js";

export type SyncDatabase = PgDatabase<PgQueryResultHKT>;

export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const PRUNE_LOCK_KEY = 7_311_207;
export const NOTIFY_PAYLOAD_LIMIT_BYTES = 8000;
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
  await db.execute(
    sql`create table if not exists sync_pruned (id int primary key, version bigint not null)`,
  );
  await db.execute(sql`
    insert into sync_pruned (id, version)
    select 1, coalesce((select min(version) - 1 from sync_events), (select v from sync_version where id = 1))
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
  await tx.execute(
    sql`select pg_notify(${SYNC_CHANNEL}, ${notifyPayload(input.scope, event)})`,
  );
  return event;
}

// pg_notify rejects payloads of 8000 bytes or more; the row keeps the full tags.
export function notifyPayload(scope: string, event: SyncEvent): string {
  const full = JSON.stringify({ scope, event });
  if (new TextEncoder().encode(full).length < NOTIFY_PAYLOAD_LIMIT_BYTES) return full;
  return JSON.stringify({ scope, event: { ...event, tags: tableTags(event.tags) } });
}

function tableTags(tags: readonly Tag[]): Tag[] {
  const tables = new Set<string | number>();
  for (const tag of tags) if (tag[0] !== undefined) tables.add(tag[0]);
  return [...tables].map((table) => [table]);
}

interface EventRow {
  id: string;
  version: number | string;
  tags: Tag[];
  source: string | null;
}

/** One scope's events, or several streams' merged on the shared version order. */
export async function readSyncEvents(
  db: SyncDatabase,
  scope: string | readonly string[],
  since: SyncCursor,
  limit: number = MAX_BATCH,
): Promise<SyncEvent[]> {
  const scopes = typeof scope === "string" ? [scope] : scope;
  const found = await rows<EventRow>(
    db.execute(sql`
      select id, version, tags, source
        from sync_events
       where scope in (${sql.join(
         scopes.map((one) => sql`${one}`),
         sql`, `,
       )})
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

export type SyncBacklog =
  | { readonly events: SyncEvent[]; readonly resetTo?: undefined }
  | { readonly resetTo: SyncCursor };

/**
 * Every event of these streams after `since`, or, when they cannot all be replayed, the
 * cursor to reset to: there are more than one batch of them, or pruning removed events
 * after `since`. The initial cursor asks for the retained log, so pruning never resets it.
 */
export async function readSyncBacklog(
  db: SyncDatabase,
  scope: string | readonly string[],
  since: SyncCursor,
): Promise<SyncBacklog> {
  const events = await readSyncEvents(db, scope, since, MAX_BATCH + 1);
  const pruned = await readPrunedVersion(db);
  const fromStart = compareCursors(since, INITIAL_CURSOR) === 0;
  if (events.length <= MAX_BATCH && (fromStart || since.version >= pruned)) {
    return { events };
  }
  const head = await readSyncCursor(db, scope);
  const floor: SyncCursor = { version: pruned, id: "" };
  return { resetTo: compareCursors(head, floor) > 0 ? head : floor };
}

async function readPrunedVersion(db: SyncDatabase): Promise<number> {
  const [row] = await rows<{ version: number | string }>(
    db.execute(sql`select version from sync_pruned where id = 1`),
  );
  return Number(row?.version ?? 0);
}

/**
 * The last event of these streams, or the initial cursor when they have none. Read before
 * a query, it marks what the query's answer already reflects: versions are allocated under
 * one row lock, so any event committed later in these streams sorts after it.
 */
export async function readSyncCursor(
  db: SyncDatabase,
  scope: string | readonly string[],
): Promise<SyncCursor> {
  const scopes = typeof scope === "string" ? [scope] : scope;
  const lasts = scopes.map(
    (one) =>
      sql`(select version, id from sync_events where scope = ${one} order by version desc, id desc limit 1)`,
  );
  const found = await rows<{ id: string; version: number | string }>(
    db.execute(sql.join(lasts, sql` union all `)),
  );
  return found
    .map((row) => ({ version: Number(row.version), id: row.id }))
    .reduce<SyncCursor>(
      (latest, cursor) => (compareCursors(cursor, latest) > 0 ? cursor : latest),
      INITIAL_CURSOR,
    );
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
    const [deleted] = await rows<{ count: number }>(
      tx.execute(sql`
        with deleted as (
          delete from sync_events where created_at < ${cutoff} returning version
        ), marked as (
          update sync_pruned set version = greatest(version, (select max(version) from deleted))
           where id = 1
        )
        select count(*)::int as count from deleted`),
    );
    return deleted?.count ?? 0;
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
