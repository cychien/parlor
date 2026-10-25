import { userAudience } from "@parlor/agent-ui/server";
import {
  type DataProvider,
  DEV_USER_ID,
  type Principal,
  type Tag,
  type UserId,
  userOf,
} from "@parlor/core";
import { REVOCATION_HORIZON_MS, type ServerPlugin } from "@parlor/server";

import type { ChatOwner } from "../model.js";
import { CHAT_PLUGIN } from "../protocol.js";
import { CHAT_TAG, type ChatActionDeps, chatActions, HOSTS_TAG } from "./actions.js";
import { inProcessRelay, type LiveRelay } from "./live.js";
import { CHAT_MIGRATIONS } from "./migrations.js";
import { chatRoutes } from "./routes.js";
import { type ChatDb, sqlChatStore } from "./store.js";

export {
  CHAT_ACTIVITY_TAG,
  CHAT_TAG,
  type ChatActionDeps,
  type ChatActionMap,
  type ChatActionRegistry,
  chatActions,
  type ChatHostActionMap,
  type ChatUserActionMap,
  HOST_GRANTS_TAG,
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
export { CHAT_PLUGIN } from "../protocol.js";
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
  type Lapsed,
  type NewTurn,
  sqlChatStore,
  type StreamTurn,
  type TurnHolder,
  type UserDraft,
} from "./store.js";

/** Chat then serves nothing, so the client reads `useChat().status` as `unavailable`. */
export const UNAVAILABLE_WITHOUT_AUTH =
  "chat() is unavailable: no auth provider is configured, so every action runs without a signed-in user.";

export const AUTH_UNDEFINED =
  "auth is undefined. Check the environment variables your auth setup reads, or remove the auth option to run without sign-in.";

/** Outlives a 30 s network drop plus a 5 s reconnect. */
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_MAX_QUEUED = 4;

/** Who asks to use the chat, with what the server knows to decide. */
export interface ChatAccessRequest {
  /** Whose chat it is: the signed-in user, or the user a connected computer works for. */
  readonly userId: UserId;
  readonly principal: Principal;
  readonly scope: string;
  readonly database: DataProvider;
}

export type ChatAccess = (request: ChatAccessRequest) => boolean | Promise<boolean>;

export interface ChatOptions {
  /**
   * Who may use the agent; everyone signed in when absent. A refused user can neither read
   * nor send, their computers take no turns, and auth pairs no computer or device for them.
   */
  readonly access?: ChatAccess | undefined;
  /** App notes for the agent in every fresh session's context, such as an AGENTS.md excerpt. */
  readonly instructions?: string | undefined;
  readonly leaseMs?: number | undefined;
  readonly maxQueued?: number | undefined;
  /** Defaults to `inProcessRelay`; a multi-instance deployment passes one that crosses instances. */
  readonly relay?: (() => LiveRelay) | undefined;
}

/** A lease past the revocation memory would outlive the revocation of its grant. */
export const MAX_LEASE_MS = REVOCATION_HORIZON_MS;

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
      if (!database) throw new Error("chat() needs a database.");
      if (!auth?.delegate) {
        if (host.authMisconfigured) throw new Error(AUTH_UNDEFINED);
        console.warn(UNAVAILABLE_WITHOUT_AUTH);
        return {};
      }
      const relay = (options.relay ?? inProcessRelay)();
      const db = () => database.read() as ChatDb;
      const ownStream = (owner: ChatOwner) => userAudience(owner.scope, owner.userId);
      const transact: ChatActionDeps["transact"] = (owner, work) =>
        database.transaction(async (tx) => {
          const { result, threadId } = await work(tx as ChatDb);
          if (threadId !== undefined)
            await host.announce(ownStream(owner), [[CHAT_TAG, threadId]], tx);
          return result;
        });
      const heartbeatMs = DEFAULT_HEARTBEAT_MS;
      const reconcile = async (owner?: ChatOwner) => {
        if (!(await sqlChatStore.hasLapsed(db(), owner))) return;
        await database.transaction(async (tx) => {
          for (const change of await sqlChatStore.expireLapsed(tx as ChatDb, owner)) {
            const tags: Tag[] = [
              ...change.threads.map((threadId) => [CHAT_TAG, threadId]),
              ...change.hosts.map((hostId) => [HOSTS_TAG, hostId]),
            ];
            await host.announce(ownStream(change), tags, tx);
          }
        });
      };
      const pruneHosts: ChatActionDeps["pruneHosts"] = async (owner, hostIds) => {
        try {
          await database.transaction((tx) =>
            sqlChatStore.pruneHosts(tx as ChatDb, owner, hostIds),
          );
        } catch (error) {
          console.warn("[parlor] chat: pruning revoked computers failed:", error);
        }
      };
      let sweep: ReturnType<typeof setInterval> | undefined;
      const actions = chatActions({
        enforcing: auth.enforcing,
        transact,
        reconcile,
        pruneHosts,
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
      const { access } = options;
      return {
        actions,
        ...(access
          ? {
              allows: ({ principal, scope }) =>
                access({
                  userId: userOf(principal) ?? DEV_USER_ID,
                  principal,
                  scope,
                  database,
                }),
            }
          : {}),
        routes: chatRoutes({
          db,
          store: sqlChatStore,
          relay,
          heartbeatMs,
          reconcile,
          announceHost: (owner, hostId) =>
            host.announce(ownStream(owner), [[HOSTS_TAG, hostId]]),
        }),
        channel: relay.channel,
        start: () => {
          sweep = setInterval(() => {
            (host.ready?.() ?? Promise.resolve())
              .then(() => reconcile())
              .catch((error: unknown) => {
                console.warn("[parlor] chat: sweeping lapsed turns failed:", error);
              });
          }, heartbeatMs);
          sweep.unref?.();
        },
        close: () => {
          clearInterval(sweep);
          relay.close();
        },
      };
    },
  };
}
