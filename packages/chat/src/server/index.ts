import type { ServerPlugin } from "@parlor/server";

import { chatActions } from "./actions.js";
import { inProcessRelay, type LiveRelay } from "./live.js";
import { CHAT_MIGRATIONS } from "./migrations.js";
import { chatRoutes } from "./routes.js";
import { type ChatDb, sqlChatStore } from "./store.js";

export {
  CHAT_TAG,
  type ChatActionDeps,
  type ChatActionMap,
  type ChatActionRegistry,
  chatActions,
  type ChatHostActionMap,
  type ChatUserActionMap,
  hostChatActions,
  HOSTS_TAG,
  userChatActions,
} from "./actions.js";
export {
  TRANSCRIPT_BUDGET_BYTES,
  turnContext,
  type TurnContextInput,
} from "./context.js";
export { chatItemBodies, hostItemDraft } from "../items.js";
export { idSchema } from "../id-schemas.js";
export {
  inProcessRelay,
  type LiveRelay,
  MAX_OPEN_BYTES_PER_TURN,
  MAX_OPEN_TURNS,
} from "./live.js";
export { CHAT_MIGRATIONS } from "./migrations.js";
export {
  type ChatActionConfig,
  chatAction,
  type ChatHost,
  type ChatUser,
  type Party,
  type PartyOf,
} from "./party.js";
export { chatRoutes, type ChatRouteDeps, MAX_STREAM_BODY_BYTES } from "./routes.js";
export {
  type ChatDb,
  type ChatStore,
  type NewTurn,
  sqlChatStore,
  type TurnHolder,
  type UserDraft,
} from "./store.js";

export const CHAT_PLUGIN = "chat";

/** Outlives a 30 s network drop plus a 5 s reconnect. */
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_MAX_QUEUED = 4;

export interface ChatOptions {
  /** App notes for the agent in every fresh session's context, such as an AGENTS.md excerpt. */
  readonly instructions?: string | undefined;
  readonly leaseMs?: number | undefined;
  readonly maxQueued?: number | undefined;
  /** Defaults to `inProcessRelay`; a multi-instance deployment passes one that crosses instances. */
  readonly relay?: (() => LiveRelay) | undefined;
}

/** A lease past the revocation memory would outlive the revocation of its grant. */
export const MAX_LEASE_MS = 11 * 60_000;

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`chat(): ${name} must be a positive whole number, got ${value}.`);
  }
  return value;
}

/**
 * The inline agent's server half: the `parlor_chat_*` log, the user and host actions, the
 * `chat` channel, and the host-only stream and heartbeat routes.
 */
export function chat(options: ChatOptions = {}): ServerPlugin {
  return {
    name: CHAT_PLUGIN,
    migrations: CHAT_MIGRATIONS,
    setup(host) {
      const leaseMs = positiveInteger("leaseMs", options.leaseMs ?? DEFAULT_LEASE_MS);
      const maxQueued = positiveInteger(
        "maxQueued",
        options.maxQueued ?? DEFAULT_MAX_QUEUED,
      );
      if (leaseMs > MAX_LEASE_MS) {
        throw new Error(
          `chat(): leaseMs ${leaseMs} is above ${MAX_LEASE_MS}, the longest a revoked computer's turn token can be kept out.`,
        );
      }
      const { auth, database } = host;
      if (!auth?.delegate) {
        throw new Error(
          "chat() needs an auth provider that can mint turn tokens; add `auth` to createServer (parlor dev installs one).",
        );
      }
      if (!database) throw new Error("chat() needs a database.");
      const relay = (options.relay ?? inProcessRelay)();
      const db = () => database.read() as ChatDb;
      const heartbeatMs = DEFAULT_HEARTBEAT_MS;
      const actions = chatActions({
        enforcing: auth.enforcing,
        auth,
        store: sqlChatStore,
        relay,
        leaseMs,
        heartbeatMs,
        maxQueued,
        instructions: options.instructions,
        appName: process.env.PARLOR_APP_NAME ?? "this app",
        appOrigin: () => process.env.PARLOR_ORIGIN ?? process.env.PARLOR_WEB_ORIGIN ?? "",
      });
      return {
        actions,
        routes: chatRoutes({ db, store: sqlChatStore, relay, heartbeatMs }),
        channel: relay.channel,
        close: () => relay.close(),
      };
    },
  };
}
