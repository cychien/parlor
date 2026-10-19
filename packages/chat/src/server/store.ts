import type { DeviceId, HostId, HostPrincipal, ThreadId, TurnId } from "@parlor/core";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { HostItemDraft, LoggedItem, UserItemKind } from "../items.js";
import type {
  AgentInfo,
  AgentRef,
  ChatOwner,
  ClaimedTurn,
  HostSummary,
  ThreadPage,
  ThreadSummary,
  TurnOutcome,
  TurnSignals,
} from "../model.js";

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
}

export interface TurnHolder {
  readonly owner: ChatOwner;
  readonly threadId: ThreadId;
  readonly hostId: HostId;
}

/**
 * The thread log in SQL. Every function filters by the owner's scope and user in the same
 * statement, so another user's thread id reads as not found. Appends lock the thread row
 * to assign gap-free `seq`, insert `on conflict (id) do nothing`, and run in the action's
 * transaction so the thread's sync event commits with them.
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
  appendHostItems(
    tx: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    turnId: TurnId,
    items: readonly HostItemDraft[],
    leaseMs: number,
  ): Promise<{ readonly threadId: ThreadId; readonly leaseUntil: number }>;
  /** Once per turn; a second call with any outcome is a no-op. */
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
  /** One UPDATE of `online_until`, no sync event. */
  heartbeat(
    db: ChatDb,
    owner: ChatOwner,
    host: HostPrincipal,
    ttlMs: number,
  ): Promise<void>;
  listHosts(db: ChatDb, owner: ChatOwner): Promise<HostSummary[]>;
  turnHolder(db: ChatDb, turnId: TurnId): Promise<TurnHolder | undefined>;
}

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export const sqlChatStore: ChatStore = {
  listThreads: notImplemented,
  readPage: notImplemented,
  readItemsAfter: notImplemented,
  appendUserItems: notImplemented,
  // TODO: expire running turns whose lease_until < now() as failed host_lost; then
  //   `select ... from parlor_chat_turns where host_id = $1 and owner_id = $2 and scope = $3
  //   and state = 'queued' and thread has no running turn order by created_at limit 1 for
  //   update skip locked`; set running, lease_until = now() + leaseMs.
  claimTurn: notImplemented,
  appendHostItems: notImplemented,
  finishTurn: notImplemented,
  readSignals: notImplemented,
  reportHost: notImplemented,
  heartbeat: notImplemented,
  listHosts: notImplemented,
  turnHolder: notImplemented,
};
