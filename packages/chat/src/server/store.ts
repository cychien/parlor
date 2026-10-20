import { randomUUID } from "node:crypto";

import {
  ActionError,
  asId,
  type DeviceId,
  type GrantId,
  type HostId,
  type HostPrincipal,
  type ItemId,
  type ThreadId,
  type TurnId,
} from "@parlor/core";
import { type SQL, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import { chatItemBodies, type ChatItemBody, type ChatItemKind } from "../items.js";
import type { HostItemDraft, LoggedItem, UserItemKind } from "../items.js";
import {
  type AgentInfo,
  type AgentRef,
  type ChatOwner,
  type ClaimedTurn,
  type HostSummary,
  type ThreadPage,
  type ThreadSummary,
  TURN_FAILURES,
  type TurnOutcome,
  type TurnSignals,
} from "../model.js";
import {
  agentInfoSchema,
  itemRow,
  threadRow,
  toLoggedItem,
  toThreadSummary,
  turnStateSchema,
} from "./rows.js";

export type ChatDb = PgDatabase<PgQueryResultHKT>;

export type UserDraft = {
  [K in UserItemKind]: {
    readonly id: LoggedItem<K>["id"];
    readonly kind: K;
    readonly body: LoggedItem<K>["body"];
  };
}[UserItemKind];

export interface NewTurn {
  readonly turnId: TurnId;
  readonly agent: AgentRef;
  readonly clientId: string;
  readonly deviceId: DeviceId | undefined;
  /** The most turns a thread may have waiting; checked under the thread's lock. */
  readonly maxQueued: number;
}

export interface TurnHolder {
  readonly owner: ChatOwner;
  readonly threadId: ThreadId;
  readonly hostId: HostId;
}

/** A turn's holder with whether it runs now: running, and its lease not yet lapsed. */
export interface StreamTurn extends TurnHolder {
  readonly live: boolean;
}

/** What one reconciliation changed in a scope, for the sync events it must emit. */
export interface Lapsed {
  readonly scope: string;
  readonly threads: readonly ThreadId[];
  readonly hosts: readonly HostId[];
}

/**
 * The thread log in SQL. Every function filters by the owner's scope and user in the same
 * statement, so another user's thread id reads as not found. Appends lock the thread row
 * to assign gap-free `seq` and run in the action's transaction so the thread's sync event
 * commits with them.
 */
export interface ChatStore {
  listThreads(db: ChatDb, owner: ChatOwner): Promise<ThreadSummary[]>;
  readPage(
    db: ChatDb,
    owner: ChatOwner,
    threadId: ThreadId | undefined,
    limit: number,
  ): Promise<Omit<ThreadPage, "open">>;
  readItemsAfter(
    db: ChatDb,
    owner: ChatOwner,
    threadId: ThreadId,
    afterSeq: number,
  ): Promise<LoggedItem[]>;
  /** With `turn`, also queues it; the thread is created on its first prompt. */
  appendUserItems(
    tx: ChatDb,
    owner: ChatOwner,
    input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly items: readonly UserDraft[];
      readonly turn?: NewTurn | undefined;
    },
  ): Promise<LoggedItem[]>;
  claimTurn(
    tx: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    leaseMs: number,
  ): Promise<Omit<ClaimedTurn, "context" | "token" | "device"> | undefined>;
  /** Whether anything waits for `expireLapsed`; one read, so the idle path writes nothing. */
  hasLapsed(db: ChatDb, owner: ChatOwner | undefined): Promise<boolean>;
  /**
   * Fails the running turns whose lease lapsed (`host_lost`) and marks the computers whose
   * liveness lapsed offline, for `owner` or, without one, for everyone. Commit it apart
   * from any claim, because a claim that finds nothing aborts its own transaction.
   */
  expireLapsed(tx: ChatDb, owner: ChatOwner | undefined): Promise<Lapsed[]>;
  /**
   * Puts a claimed turn back in the queue when the host never learned of the claim.
   * Refused (false) once the turn has an agent item or is no longer running.
   */
  releaseClaim(
    tx: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    turnId: TurnId,
  ): Promise<boolean>;
  appendHostItems(
    tx: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    turnId: TurnId,
    items: readonly HostItemDraft[],
    leaseMs: number,
  ): Promise<{
    readonly threadId: ThreadId;
    readonly leaseUntil: number;
    /** What the renewed turn token binds, so the caller need not read the turn again. */
    readonly clientId: string;
    readonly agentId: string;
  }>;
  /** Once per turn; a second call with any outcome is refused and changes nothing. */
  finishTurn(
    tx: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    turnId: TurnId,
    outcome: TurnOutcome,
  ): Promise<{ readonly threadId: ThreadId }>;
  readSignals(
    db: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    turns: readonly { readonly turnId: TurnId; readonly afterSeq: number }[],
  ): Promise<TurnSignals[]>;
  reportHost(
    tx: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    report: {
      readonly protocol: number;
      readonly name: string;
      readonly platform: string;
      readonly agents: readonly AgentInfo[];
      readonly online: boolean;
      readonly ttlMs: number;
    },
  ): Promise<{ readonly onlineUntil: number }>;
  /**
   * One UPDATE of `online_until`. `returned` is true when the sidebar had been told the
   * computer was offline, so the caller announces its return.
   */
  heartbeat(
    db: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    ttlMs: number,
  ): Promise<{ readonly returned: boolean }>;
  listHosts(db: ChatDb, owner: ChatOwner): Promise<StoredHost[]>;
  /** Drops the owner's computer rows whose grant is gone. */
  pruneHosts(tx: ChatDb, owner: ChatOwner, hostIds: readonly HostId[]): Promise<void>;
  turnHolder(db: ChatDb, turnId: TurnId): Promise<StreamTurn | undefined>;
}

export interface StoredHost extends HostSummary {
  readonly grantId: GrantId;
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return rows ?? [];
}

async function query<S extends z.ZodType>(
  db: ChatDb,
  statement: SQL,
  schema: S,
): Promise<z.output<S>[]> {
  const result = await db.execute(statement);
  return rowsOf(result).map((row) => schema.parse(row));
}

const count = z.coerce.number();
const ms = (column: string) => sql.raw(`(extract(epoch from ${column}) * 1000)::bigint`);
const ITEM_COLUMNS = sql`id, thread_id, turn_id, seq, kind, body, ${ms("created_at")} as at`;
const ITEM_COLUMNS_OF_I = sql`i.id, i.thread_id, i.turn_id, i.seq, i.kind, i.body, ${ms("i.created_at")} as at`;
const THREAD_COLUMNS = sql`id, title, host_id, agent_id, last_seq, ${ms("updated_at")} as updated_at`;

const THREAD_LIST_LIMIT = 200;
const TITLE_CHARS = 80;
const TERMINAL_STATES: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

const threadMissing = () => new ActionError("not_found", "Thread not found");
const turnMissing = () => new ActionError("not_found", "Turn not found");

const inList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

const authorOf = (kind: ChatItemKind) => chatItemBodies[kind].author;

function titleOf(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return [...firstLine].slice(0, TITLE_CHARS).join("");
}

interface ItemInsert {
  readonly id: ItemId;
  readonly turnId: TurnId;
  readonly kind: ChatItemKind;
  readonly body: unknown;
}

interface LogLock {
  readonly lastSeq: number;
  readonly turnState: string | undefined;
  /** Running and its lease has not lapsed: the only turn a host may write to. */
  readonly leased: boolean;
}

/** The only place the log is locked: the thread row, then the turn row. */
async function lockLog(
  tx: ChatDb,
  owner: ChatOwner,
  threadId: ThreadId,
  turnId?: TurnId,
): Promise<LogLock> {
  const [row] = await query(
    tx,
    sql`select last_seq from parlor_chat_threads
      where id = ${threadId} and scope = ${owner.scope} and owner_id = ${owner.userId}
      for update`,
    z.object({ last_seq: count }),
  );
  if (!row) throw threadMissing();
  if (turnId === undefined) {
    return { lastSeq: row.last_seq, turnState: undefined, leased: false };
  }
  const [turn] = await query(
    tx,
    sql`select state, coalesce(state = 'running' and lease_until >= now(), false) as leased
      from parlor_chat_turns where id = ${turnId} and thread_id = ${threadId} for update`,
    z.object({ state: z.string(), leased: z.boolean() }),
  );
  return {
    lastSeq: row.last_seq,
    turnState: turn?.state,
    leased: turn?.leased ?? false,
  };
}

async function insertItems(
  tx: ChatDb,
  threadId: ThreadId,
  lastSeq: number,
  rows: readonly ItemInsert[],
): Promise<number> {
  if (rows.length === 0) return lastSeq;
  const values = rows.map(
    (row, index) =>
      sql`(${row.id}, ${threadId}, ${row.turnId}, ${lastSeq + index + 1}, ${authorOf(row.kind)}, ${row.kind}, ${JSON.stringify(row.body)}::jsonb)`,
  );
  await tx.execute(
    sql`insert into parlor_chat_items (id, thread_id, turn_id, seq, author, kind, body)
      values ${sql.join(values, sql`, `)}`,
  );
  const next = lastSeq + rows.length;
  await tx.execute(
    sql`update parlor_chat_threads set last_seq = ${next}, updated_at = now() where id = ${threadId}`,
  );
  return next;
}

async function itemThreads(
  tx: ChatDb,
  ids: readonly ItemId[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await query(
    tx,
    sql`select id, thread_id from parlor_chat_items where id in (${inList(ids)})`,
    z.object({ id: z.string(), thread_id: z.string() }),
  );
  return new Map(rows.map((row) => [row.id, row.thread_id]));
}

async function itemsById(
  db: ChatDb,
  threadId: ThreadId,
  ids: readonly ItemId[],
): Promise<LoggedItem[]> {
  if (ids.length === 0) return [];
  const rows = await query(
    db,
    sql`select ${ITEM_COLUMNS} from parlor_chat_items
      where thread_id = ${threadId} and id in (${inList(ids)}) order by seq`,
    itemRow,
  );
  return rows.map(toLoggedItem);
}

const turnRow = z.object({
  id: idSchema("turn"),
  thread_id: idSchema("thread"),
  host_id: idSchema("host"),
  agent_id: z.string(),
  state: turnStateSchema,
  lapsed: z.boolean(),
  failure: z.enum(TURN_FAILURES).nullable(),
});

async function createTurn(
  tx: ChatDb,
  owner: ChatOwner,
  threadId: ThreadId,
  turn: NewTurn,
  promptItemId: ItemId,
): Promise<void> {
  const [existing] = await query(
    tx,
    sql`select thread_id, owner_id, scope from parlor_chat_turns where id = ${turn.turnId}`,
    z.object({ thread_id: z.string(), owner_id: z.string(), scope: z.string() }),
  );
  if (existing) {
    const sameThread =
      existing.thread_id === threadId &&
      existing.owner_id === owner.userId &&
      existing.scope === owner.scope;
    if (!sameThread) throw turnMissing();
    return;
  }
  const [queued] = await query(
    tx,
    sql`select count(*) as waiting from parlor_chat_turns
      where thread_id = ${threadId} and state = 'queued'`,
    z.object({ waiting: count }),
  );
  if ((queued?.waiting ?? 0) >= turn.maxQueued) {
    throw new ActionError(
      "invalid_input",
      "Too many prompts are waiting for the agent; wait for it to catch up.",
    );
  }
  await tx.execute(
    sql`insert into parlor_chat_turns
      (id, thread_id, scope, owner_id, host_id, agent_id, client_id, device_id, prompt_item_id, state)
      values (${turn.turnId}, ${threadId}, ${owner.scope}, ${owner.userId}, ${turn.agent.hostId},
        ${turn.agent.agentId}, ${turn.clientId}, ${turn.deviceId ?? null}, ${promptItemId}, 'queued')`,
  );
}

async function admitsUserItem(
  tx: ChatDb,
  threadId: ThreadId,
  turnId: TurnId,
  draft: UserDraft,
): Promise<boolean> {
  if (draft.kind === "prompt") return true;
  if (draft.kind === "answer") {
    const askId = draft.body.askId;
    const [ask] = await query(
      tx,
      sql`select turn_id, body->>'approval' as approval from parlor_chat_items
        where thread_id = ${threadId} and id = ${askId} and kind = 'ask'`,
      z.object({ turn_id: z.string(), approval: z.string().nullable() }),
    );
    if (!ask || ask.turn_id !== turnId)
      throw new ActionError("not_found", "Question not found");
    if (ask.approval === "computer") {
      throw new ActionError("forbidden", "This question is answered on the computer.");
    }
    const { signed } = draft.body;
    if (
      ask.approval === "presence" &&
      !(signed?.signature.format === "webauthn" && signed.signature.presence === "user")
    ) {
      throw new ActionError("forbidden", "This question needs a presence check.");
    }
    const [state] = await query(
      tx,
      sql`select state from parlor_chat_turns where id = ${turnId} for update`,
      z.object({ state: z.string() }),
    );
    const [standing] = await query(
      tx,
      sql`select a.id from parlor_chat_items a
        where a.thread_id = ${threadId} and a.kind = 'answer' and a.body->>'askId' = ${askId}
          and not exists (
            select 1 from parlor_chat_items e
            where e.thread_id = ${threadId} and e.kind = 'event'
              and e.body->>'event' = 'answer_rejected' and e.body->>'itemId' = a.id)
        limit 1`,
      z.object({ id: z.string() }),
    );
    if (standing) {
      throw new ActionError("invalid_input", "This question was already answered.");
    }
    if (state?.state !== "running") {
      throw new ActionError(
        "invalid_input",
        "The agent is no longer waiting for this answer.",
      );
    }
    return true;
  }
  const [turn] = await query(
    tx,
    sql`select state from parlor_chat_turns where id = ${turnId} and thread_id = ${threadId}`,
    z.object({ state: z.string() }),
  );
  if (!turn) throw turnMissing();
  if (TERMINAL_STATES.has(turn.state)) return false;
  if (turn.state === "queued") {
    await tx.execute(
      sql`update parlor_chat_turns
        set state = 'cancelled', outcome = '{"state":"cancelled"}'::jsonb, finished_at = now()
        where id = ${turnId} and state = 'queued'`,
    );
  }
  return true;
}

const lostItemId = () => asId("item", `lost.${randomUUID()}`);

const ownedBy = (owner: ChatOwner | undefined) =>
  owner ? sql`and owner_id = ${owner.userId} and scope = ${owner.scope}` : sql``;

async function lapsedFor(db: ChatDb, owner: ChatOwner | undefined): Promise<boolean> {
  const [found] = await query(
    db,
    sql`select (
        exists (select 1 from parlor_chat_turns
          where state = 'running' and lease_until < now() ${ownedBy(owner)})
        or exists (select 1 from parlor_chat_hosts
          where announced_online and online_until <= now() ${ownedBy(owner)})
      ) as lapsed`,
    z.object({ lapsed: z.boolean() }),
  );
  return found?.lapsed ?? false;
}

async function expireLapsed(tx: ChatDb, owner: ChatOwner | undefined): Promise<Lapsed[]> {
  const changes = new Map<string, { threads: ThreadId[]; hosts: HostId[] }>();
  const changed = (scope: string) => {
    let change = changes.get(scope);
    if (!change) changes.set(scope, (change = { threads: [], hosts: [] }));
    return change;
  };
  const lapsed = await query(
    tx,
    sql`select distinct scope, owner_id, thread_id from parlor_chat_turns
      where state = 'running' and lease_until < now() ${ownedBy(owner)}
      order by thread_id`,
    z.object({
      scope: z.string(),
      owner_id: idSchema("user"),
      thread_id: idSchema("thread"),
    }),
  );
  for (const { scope, owner_id: userId, thread_id: threadId } of lapsed) {
    const { lastSeq } = await lockLog(tx, { scope, userId }, threadId);
    const expired = await query(
      tx,
      sql`update parlor_chat_turns
        set state = 'failed', outcome = '{"state":"failed","reason":"host_lost"}'::jsonb,
          finished_at = now()
        where thread_id = ${threadId} and state = 'running' and lease_until < now()
        returning id`,
      z.object({ id: idSchema("turn") }),
    );
    if (expired.length === 0) continue;
    await insertItems(
      tx,
      threadId,
      lastSeq,
      expired.map(({ id }) => ({
        id: lostItemId(),
        turnId: id,
        kind: "event",
        body: { event: "host_lost" } satisfies ChatItemBody<"event">,
      })),
    );
    changed(scope).threads.push(threadId);
  }
  const offline = await query(
    tx,
    sql`update parlor_chat_hosts set announced_online = false
      where announced_online and online_until <= now() ${ownedBy(owner)}
      returning id, scope`,
    z.object({ id: idSchema("host"), scope: z.string() }),
  );
  for (const { id, scope } of offline) changed(scope).hosts.push(id);
  return [...changes].map(([scope, change]) => ({ scope, ...change }));
}

async function lockRunningTurn(
  tx: ChatDb,
  owner: ChatOwner,
  host: HostPrincipal,
  turnId: TurnId,
): Promise<{
  readonly threadId: ThreadId;
  readonly lastSeq: number;
  readonly clientId: string;
  readonly agentId: string;
}> {
  const [found] = await query(
    tx,
    sql`select thread_id, client_id, agent_id from parlor_chat_turns
      where id = ${turnId} and host_id = ${host.hostId}
        and owner_id = ${owner.userId} and scope = ${owner.scope}`,
    z.object({
      thread_id: idSchema("thread"),
      client_id: z.string(),
      agent_id: z.string(),
    }),
  );
  if (!found) throw turnMissing();
  const { lastSeq, leased } = await lockLog(tx, owner, found.thread_id, turnId);
  if (!leased) throw new ActionError("forbidden", "The turn is not running.");
  return {
    threadId: found.thread_id,
    lastSeq,
    clientId: found.client_id,
    agentId: found.agent_id,
  };
}

const leaseSql = (leaseMs: number) =>
  sql`now() + ${leaseMs}::float8 * interval '1 millisecond'`;

export const sqlChatStore: ChatStore = {
  async listThreads(db, owner) {
    const rows = await query(
      db,
      sql`select ${THREAD_COLUMNS} from parlor_chat_threads
        where owner_id = ${owner.userId} and scope = ${owner.scope}
        order by updated_at desc, id limit ${THREAD_LIST_LIMIT}`,
      threadRow,
    );
    return rows.map(toThreadSummary);
  },

  async readPage(db, owner, threadId, limit) {
    const [row] = await query(
      db,
      threadId
        ? sql`select ${THREAD_COLUMNS} from parlor_chat_threads
            where id = ${threadId} and owner_id = ${owner.userId} and scope = ${owner.scope}`
        : sql`select ${THREAD_COLUMNS} from parlor_chat_threads
            where owner_id = ${owner.userId} and scope = ${owner.scope}
            order by updated_at desc, id limit 1`,
      threadRow,
    );
    if (!row) return { thread: undefined, items: [], turns: [], hasMore: false };
    const rows = await query(
      db,
      sql`select ${ITEM_COLUMNS} from parlor_chat_items
        where thread_id = ${row.id} order by seq desc limit ${limit + 1}`,
      itemRow,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse().map(toLoggedItem);
    const first = items[0];
    const turns = first
      ? await query(
          db,
          sql`select id, thread_id, host_id, agent_id, state,
              coalesce(state = 'running' and lease_until < now(), false) as lapsed,
              case when state = 'failed' then outcome->>'reason' end as failure
            from parlor_chat_turns
            where thread_id = ${row.id}
              and id in (select turn_id from parlor_chat_items
                where thread_id = ${row.id} and seq >= ${first.seq})
            order by created_at, id`,
          turnRow,
        )
      : [];
    return {
      thread: toThreadSummary(row),
      items,
      turns: turns.map((turn) => ({
        turnId: turn.id,
        state: turn.lapsed ? "failed" : turn.state,
        agent: { hostId: turn.host_id, agentId: turn.agent_id },
        failure: turn.lapsed ? "host_lost" : (turn.failure ?? undefined),
      })),
      hasMore,
    };
  },

  async readItemsAfter(db, owner, threadId, afterSeq) {
    const rows = await query(
      db,
      sql`select ${ITEM_COLUMNS_OF_I} from parlor_chat_items i
        join parlor_chat_threads t on t.id = i.thread_id
        where t.id = ${threadId} and t.owner_id = ${owner.userId} and t.scope = ${owner.scope}
          and i.seq > ${afterSeq}
        order by i.seq`,
      itemRow,
    );
    if (rows.length === 0) {
      const [thread] = await query(
        db,
        sql`select id from parlor_chat_threads
          where id = ${threadId} and owner_id = ${owner.userId} and scope = ${owner.scope}`,
        z.object({ id: z.string() }),
      );
      if (!thread) throw threadMissing();
    }
    return rows.map(toLoggedItem);
  },

  async appendUserItems(tx, owner, input) {
    const { threadId, turnId, items, turn } = input;
    if (turn) {
      const prompt = items.find((draft) => draft.kind === "prompt");
      await tx.execute(
        sql`insert into parlor_chat_threads (id, scope, owner_id, title, host_id, agent_id)
          values (${threadId}, ${owner.scope}, ${owner.userId},
            ${prompt?.kind === "prompt" ? titleOf(prompt.body.text) : ""},
            ${turn.agent.hostId}, ${turn.agent.agentId})
          on conflict (id) do nothing`,
      );
    }
    const { lastSeq } = await lockLog(tx, owner, threadId);
    if (turn) {
      const prompt = items.find((draft) => draft.kind === "prompt");
      if (!prompt) throw new ActionError("invalid_input", "A turn starts with a prompt.");
      await createTurn(tx, owner, threadId, turn, prompt.id);
    }
    const known = await itemThreads(
      tx,
      items.map((draft) => draft.id),
    );
    const fresh: UserDraft[] = [];
    for (const draft of items) {
      const where = known.get(draft.id);
      if (where === undefined) {
        if (await admitsUserItem(tx, threadId, turnId, draft)) fresh.push(draft);
      } else if (where !== threadId) {
        throw threadMissing();
      }
    }
    await insertItems(
      tx,
      threadId,
      lastSeq,
      fresh.map((draft) => ({
        id: draft.id,
        turnId,
        kind: draft.kind,
        body: draft.body,
      })),
    );
    if (turn) {
      await tx.execute(
        sql`update parlor_chat_threads set host_id = ${turn.agent.hostId}, agent_id = ${turn.agent.agentId}
          where id = ${threadId}`,
      );
    }
    return itemsById(
      tx,
      threadId,
      items.map((draft) => draft.id),
    );
  },

  async hasLapsed(db, owner) {
    return lapsedFor(db, owner);
  },

  expireLapsed,

  async claimTurn(tx, owner, host, leaseMs) {
    const [claimed] = await query(
      tx,
      sql`select t.id, t.thread_id, t.agent_id, t.client_id, t.prompt_item_id
        from parlor_chat_turns t
        where t.host_id = ${host.hostId} and t.owner_id = ${owner.userId}
          and t.scope = ${owner.scope} and t.state = 'queued'
          and not exists (
            select 1 from parlor_chat_turns earlier
            where earlier.thread_id = t.thread_id and earlier.state in ('queued', 'running')
              and (earlier.created_at, earlier.id) < (t.created_at, t.id))
        order by t.created_at, t.id
        limit 1
        for update of t skip locked`,
      z.object({
        id: idSchema("turn"),
        thread_id: idSchema("thread"),
        agent_id: z.string(),
        client_id: z.string(),
        prompt_item_id: idSchema("item"),
      }),
    );
    if (!claimed) return undefined;
    const [lease] = await query(
      tx,
      sql`update parlor_chat_turns set state = 'running', lease_until = ${leaseSql(leaseMs)}
        where id = ${claimed.id}
        returning ${ms("lease_until")} as lease_until`,
      z.object({ lease_until: count }),
    );
    const [prompt] = await itemsById(tx, claimed.thread_id, [claimed.prompt_item_id]);
    if (!lease || prompt?.kind !== "prompt") {
      throw new ActionError("internal", "The claimed turn lost its prompt.");
    }
    return {
      id: claimed.thread_id,
      turnId: claimed.id,
      agent: { hostId: host.hostId, agentId: claimed.agent_id },
      clientId: claimed.client_id,
      prompt,
      leaseUntil: lease.lease_until,
    };
  },

  async releaseClaim(tx, owner, host, turnId) {
    const released = await query(
      tx,
      sql`update parlor_chat_turns set state = 'queued', lease_until = null
        where id = ${turnId} and host_id = ${host.hostId} and owner_id = ${owner.userId}
          and scope = ${owner.scope} and state = 'running' and lease_until >= now()
          and not exists (
            select 1 from parlor_chat_items i
            where i.turn_id = parlor_chat_turns.id and i.author <> 'user')
        returning thread_id`,
      z.object({ thread_id: idSchema("thread") }),
    );
    return released.length > 0;
  },

  async appendHostItems(tx, owner, host, turnId, items, leaseMs) {
    const { threadId, lastSeq, clientId, agentId } = await lockRunningTurn(
      tx,
      owner,
      host,
      turnId,
    );
    const known = await itemThreads(
      tx,
      items.map((draft) => draft.id),
    );
    const fresh: HostItemDraft[] = [];
    for (const draft of items) {
      const where = known.get(draft.id);
      if (where === undefined) fresh.push(draft);
      else if (where !== threadId)
        throw new ActionError("forbidden", "That item id is taken.");
    }
    await insertItems(
      tx,
      threadId,
      lastSeq,
      fresh.map((draft) => ({
        id: draft.id,
        turnId,
        kind: draft.kind,
        body: draft.body,
      })),
    );
    const [lease] = await query(
      tx,
      sql`update parlor_chat_turns set lease_until = ${leaseSql(leaseMs)}
        where id = ${turnId} returning ${ms("lease_until")} as lease_until`,
      z.object({ lease_until: count }),
    );
    return { threadId, leaseUntil: lease?.lease_until ?? 0, clientId, agentId };
  },

  async finishTurn(tx, owner, host, turnId, outcome) {
    const { threadId } = await lockRunningTurn(tx, owner, host, turnId);
    await tx.execute(
      sql`update parlor_chat_turns
        set state = ${outcome.state}, outcome = ${JSON.stringify(outcome)}::jsonb, finished_at = now()
        where id = ${turnId}`,
    );
    await tx.execute(
      sql`update parlor_chat_threads set updated_at = now() where id = ${threadId}`,
    );
    return { threadId };
  },

  async readSignals(db, owner, host, turns) {
    if (turns.length === 0) return [];
    const wanted = turns.map(
      ({ turnId, afterSeq }) => sql`(${turnId}::text, ${afterSeq}::bigint)`,
    );
    const rows = await query(
      db,
      sql`select ${ITEM_COLUMNS_OF_I}
        from parlor_chat_items i
        join parlor_chat_turns t on t.id = i.turn_id and t.thread_id = i.thread_id
        join (values ${sql.join(wanted, sql`, `)}) as q(turn_id, after_seq)
          on q.turn_id = i.turn_id
        where t.host_id = ${host.hostId} and t.owner_id = ${owner.userId}
          and t.scope = ${owner.scope} and i.kind in ('answer', 'cancel')
          and i.seq > q.after_seq
        order by i.turn_id, i.seq`,
      itemRow,
    );
    const byTurn = new Map<TurnId, LoggedItem<"answer" | "cancel">[]>();
    for (const item of rows.map(toLoggedItem)) {
      if (item.kind !== "answer" && item.kind !== "cancel") continue;
      const list = byTurn.get(item.turnId) ?? [];
      list.push(item);
      byTurn.set(item.turnId, list);
    }
    return [...byTurn].map(([turnId, items]) => ({ turnId, items }));
  },

  async reportHost(tx, owner, host, report) {
    const ttlMs = report.online ? report.ttlMs : 0;
    const [row] = await query(
      tx,
      sql`insert into parlor_chat_hosts
        (id, scope, owner_id, grant_id, protocol, name, platform, agents, online_until,
          announced_online)
        values (${host.hostId}, ${owner.scope}, ${owner.userId}, ${host.grantId},
          ${report.protocol}, ${report.name}, ${report.platform},
          ${JSON.stringify(report.agents)}::jsonb, ${leaseSql(ttlMs)}, ${report.online})
        on conflict (id) do update set
          grant_id = excluded.grant_id, protocol = excluded.protocol, name = excluded.name,
          platform = excluded.platform, agents = excluded.agents,
          online_until = excluded.online_until,
          announced_online = excluded.announced_online
        where parlor_chat_hosts.owner_id = excluded.owner_id
          and parlor_chat_hosts.scope = excluded.scope
        returning ${ms("online_until")} as online_until`,
      z.object({ online_until: count }),
    );
    if (!row)
      throw new ActionError("forbidden", "This computer belongs to another account.");
    return { onlineUntil: row.online_until };
  },

  async heartbeat(db, owner, host, ttlMs) {
    const [beat] = await query(
      db,
      sql`update parlor_chat_hosts as h
        set online_until = ${leaseSql(ttlMs)}, announced_online = true
        from (select announced_online as was from parlor_chat_hosts where id = ${host.hostId}) as prev
        where h.id = ${host.hostId} and h.owner_id = ${owner.userId}
          and h.scope = ${owner.scope} and h.grant_id = ${host.grantId}
        returning prev.was as was`,
      z.object({ was: z.boolean() }),
    );
    return { returned: beat !== undefined && !beat.was };
  },

  async listHosts(db, owner) {
    return query(
      db,
      sql`select id, grant_id, name, platform, agents, online_until > now() as online
        from parlor_chat_hosts
        where owner_id = ${owner.userId} and scope = ${owner.scope}
        order by name, id`,
      z
        .object({
          id: idSchema("host"),
          grant_id: idSchema("grant"),
          name: z.string(),
          platform: z.string(),
          agents: z.array(agentInfoSchema),
          online: z.boolean(),
        })
        .transform(({ grant_id, ...host }) => ({ ...host, grantId: grant_id })),
    );
  },

  async pruneHosts(tx, owner, hostIds) {
    if (hostIds.length === 0) return;
    await tx.execute(
      sql`delete from parlor_chat_hosts
        where owner_id = ${owner.userId} and scope = ${owner.scope} and id in (${inList(hostIds)})`,
    );
  },

  async turnHolder(db, turnId) {
    const [row] = await query(
      db,
      sql`select scope, owner_id, thread_id, host_id,
          coalesce(state = 'running' and lease_until >= now(), false) as live
        from parlor_chat_turns where id = ${turnId}`,
      z.object({
        scope: z.string(),
        owner_id: idSchema("user"),
        thread_id: idSchema("thread"),
        host_id: idSchema("host"),
        live: z.boolean(),
      }),
    );
    return row
      ? {
          owner: { scope: row.scope, userId: row.owner_id },
          threadId: row.thread_id,
          hostId: row.host_id,
          live: row.live,
        }
      : undefined;
  },
};
