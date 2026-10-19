import type { ServerPlugin } from "@parlor/server";

import type { LiveRelay } from "./live.js";
import { CHAT_MIGRATIONS } from "./migrations.js";

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

/**
 * The inline agent's server half: the `parlor_chat_*` log, the user and host actions, the
 * `chat` channel, and the host-only stream and heartbeat routes.
 */
export function chat(options: ChatOptions = {}): ServerPlugin {
  return {
    name: CHAT_PLUGIN,
    migrations: CHAT_MIGRATIONS,
    setup(host) {
      // TODO: refuse to start without host.auth?.delegate (production without auth;
      //   `parlor dev` gets devAuth); relay = (options.relay ?? inProcessRelay)();
      //   appName from PARLOR_APP_NAME, appOrigin from PARLOR_ORIGIN or the request;
      //   actions = chatActions({ enforcing: host.auth.enforcing, auth: host.auth, store:
      //   sqlChatStore, relay, leaseMs, heartbeatMs, maxQueued, instructions, ... });
      //   routes = chatRoutes(...); channel = relay.channel; close = relay.close.
      void options;
      void host;
      throw new Error("not implemented");
    },
  };
}
