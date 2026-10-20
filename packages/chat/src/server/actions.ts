import {
  type ActionContext,
  ActionError,
  type HostId,
  type ThreadId,
  type TurnId,
} from "@parlor/core";
import { type ActionsOf, createRegistry } from "@parlor/core/registry";
import { type AuthProvider, HOST_GRANTS_TAG } from "@parlor/server";
import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import { chatItemBodies, hostItemDraft, type LoggedItem } from "../items.js";
import type {
  AgentInfo,
  ChatOwner,
  ChatSnapshot,
  ClaimedTurn,
  HostSummary,
  TurnSignals,
} from "../model.js";
import { HOST_PROTOCOL, type HostWelcome } from "../protocol.js";
import { CHAT_TAG, HOSTS_TAG } from "../tags.js";
import { turnContext } from "./context.js";
import type { LiveRelay } from "./live.js";
import { type ChatHost, chatAction } from "./party.js";
import { agentInfoSchema, TURN_FAILURES } from "./rows.js";
import type { ChatDb, ChatStore, StoredHost } from "./store.js";

export { CHAT_TAG, HOSTS_TAG, HOST_GRANTS_TAG };

export interface Written<T> {
  readonly result: T;
  readonly threadId: ThreadId | undefined;
}

export interface ChatActionDeps {
  readonly enforcing: boolean;
  /**
   * Runs `work` in one transaction with the thread's sync event. Actions that call the auth
   * provider do so outside it, because a provider may read through another connection
   * (PGlite has one, and the transaction holds it).
   */
  readonly transact: <T>(
    scope: string,
    work: (tx: ChatDb) => Promise<Written<T>>,
  ) => Promise<T>;
  /** Commits the lapsed leases and liveness of `owner`, with the sync events they owe. */
  readonly reconcile: (owner: ChatOwner) => Promise<void>;
  /** Drops the owner's computer rows whose grant is gone; best effort, never fails a read. */
  readonly pruneHosts: (owner: ChatOwner, hostIds: readonly HostId[]) => Promise<void>;
  readonly auth: AuthProvider;
  readonly store: ChatStore;
  readonly relay: LiveRelay;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly maxQueued: number;
  readonly instructions: string | undefined;
  readonly appName: string;
  readonly appOrigin: (ctx: ActionContext) => string;
}

const threadId = idSchema("thread");
const turnId = idSchema("turn");
const itemId = idSchema("item");
const afterSeq = z.number().int().min(0);

const MIN_HOST_PROTOCOL = 2;
const CONTEXT_HISTORY_ITEMS = 200;
const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

const dbOf = (ctx: ActionContext) => ctx.db as ChatDb;

async function activeHosts(
  deps: ChatActionDeps,
  db: ChatDb,
  owner: ChatOwner,
): Promise<StoredHost[]> {
  const hosts = await deps.store.listHosts(db, owner);
  const { hostActive } = deps.auth;
  if (!hostActive) return hosts;
  const holding = await Promise.all(
    hosts.map((host) => hostActive.call(deps.auth, host.grantId)),
  );
  const gone = hosts.filter((_host, at) => !holding[at]);
  if (gone.length > 0) {
    await deps.pruneHosts(
      owner,
      gone.map((host) => host.id),
    );
  }
  return hosts.filter((_host, at) => holding[at]);
}

const summaryOf = ({
  grantId: _grantId,
  protocol: _protocol,
  ...summary
}: StoredHost): HostSummary => summary;

export function userChatActions(deps: ChatActionDeps) {
  const { enforcing } = deps;
  return {
    open: chatAction("user", enforcing, {
      description:
        "The sidebar's first paint in one round trip: threads, computers, and a thread's last page with what streams now.",
      input: z.object({
        threadId: threadId.optional(),
        limit: z.number().int().min(1).max(500).default(200),
      }),
      reads: (input) => [
        [CHAT_TAG, ...(input.threadId ? [input.threadId] : [])],
        [HOSTS_TAG],
        [HOST_GRANTS_TAG],
      ],
      run: async (input, user, ctx): Promise<ChatSnapshot> => {
        const db = dbOf(ctx);
        const [threads, hosts, page] = await Promise.all([
          deps.store.listThreads(db, user),
          activeHosts(deps, db, user),
          deps.store.readPage(db, user, input.threadId, input.limit),
        ]);
        const thread = page.thread;
        const open = thread ? deps.relay.open(user, thread.id) : [];
        const streaming = open.filter((turn) => {
          const state = page.turns.find((status) => status.turnId === turn.turnId)?.state;
          const ended = state !== undefined && TERMINAL.has(state);
          if (ended) deps.relay.settle(user, turn.threadId, turn.turnId);
          return !ended;
        });
        return {
          threads,
          hosts: hosts.map(summaryOf),
          page: { ...page, open: streaming },
        };
      },
    }),
    items: chatAction("user", enforcing, {
      description: "A thread's items after a sequence number.",
      input: z.object({ threadId, afterSeq }),
      reads: (input) => [[CHAT_TAG, input.threadId]],
      run: (input, user, ctx): Promise<LoggedItem[]> =>
        deps.store.readItemsAfter(dbOf(ctx), user, input.threadId, input.afterSeq),
    }),
    hosts: chatAction("user", enforcing, {
      description: "The user's computers and the agents on them.",
      input: z.object({}),
      reads: [HOSTS_TAG, HOST_GRANTS_TAG],
      run: async (_input, user, ctx): Promise<HostSummary[]> =>
        (await activeHosts(deps, dbOf(ctx), user)).map(summaryOf),
    }),
    send: chatAction("user", enforcing, {
      description: "Send a prompt to an agent on one of the user's computers.",
      input: z.object({
        threadId,
        turnId,
        itemId,
        clientId: z.string().min(1).max(128),
        prompt: chatItemBodies.prompt.body,
      }),
      run: async (
        input,
        user,
        ctx,
      ): Promise<{ readonly id: string; readonly turnId: string }> => {
        const hosts = await activeHosts(deps, dbOf(ctx), user);
        const host = hosts.find(
          (candidate) => candidate.id === input.prompt.agent.hostId,
        );
        if (!host) throw new ActionError("not_found", "Computer not found");
        return deps.transact(ctx.scope, async (tx) => {
          await deps.store.appendUserItems(tx, user, {
            threadId: input.threadId,
            turnId: input.turnId,
            items: [{ id: input.itemId, kind: "prompt", body: input.prompt }],
            turn: {
              turnId: input.turnId,
              agent: input.prompt.agent,
              clientId: input.clientId,
              deviceId: user.deviceId,
              maxQueued: deps.maxQueued,
            },
          });
          return {
            result: { id: input.threadId, turnId: input.turnId },
            threadId: input.threadId,
          };
        });
      },
    }),
    answer: chatAction("user", enforcing, {
      description: "Answer the agent's permission prompt or question.",
      input: z.object({ threadId, turnId, itemId, answer: chatItemBodies.answer.body }),
      run: async (input, user, ctx): Promise<{ readonly id: string }> => {
        const { signed } = input.answer;
        if (signed && deps.auth.device) {
          const device = await deps.auth.device(user.userId, signed.deviceId);
          if (!device) {
            throw new ActionError("forbidden", "This device cannot answer.");
          }
        }
        return deps.transact(ctx.scope, async (tx) => {
          await deps.store.appendUserItems(tx, user, {
            threadId: input.threadId,
            turnId: input.turnId,
            items: [{ id: input.itemId, kind: "answer", body: input.answer }],
          });
          return { result: { id: input.threadId }, threadId: input.threadId };
        });
      },
    }),
    cancel: chatAction("user", enforcing, {
      description: "Stop the running turn; what the agent already said is kept.",
      input: z.object({ threadId, turnId, itemId }),
      writes: [CHAT_TAG],
      run: async (input, user, ctx): Promise<{ readonly id: string }> => {
        await deps.store.appendUserItems(dbOf(ctx), user, {
          threadId: input.threadId,
          turnId: input.turnId,
          items: [{ id: input.itemId, kind: "cancel", body: {} }],
        });
        return { id: input.threadId };
      },
    }),
  };
}

/** What the user's computers call; `hostHello` first on every link. */
export function hostChatActions(deps: ChatActionDeps) {
  const { enforcing } = deps;
  const welcomed = new Set<HostId>();
  const welcome = async (host: ChatHost, db: ChatDb) => {
    const hosts = await deps.store.listHosts(db, host);
    const known = hosts.find((candidate) => candidate.id === host.host.hostId);
    if (!known) throw new ActionError("forbidden", "Say hello before anything else.");
    if (known.protocol < MIN_HOST_PROTOCOL) {
      await deps.pruneHosts(host, [known.id]);
      throw new ActionError("forbidden", "Say hello before anything else.");
    }
    welcomed.add(known.id);
    return known;
  };
  const requireWelcome = async (host: ChatHost, db: ChatDb) => {
    if (!welcomed.has(host.host.hostId)) await welcome(host, db);
  };
  const agentNames = new Map<HostId, ReadonlyMap<string, string>>();
  const learnAgents = (hostId: HostId, agents: readonly AgentInfo[]) => {
    agentNames.set(hostId, new Map(agents.map((agent) => [agent.id, agent.name])));
  };
  const agentNameOf = async (host: ChatHost, db: ChatDb, agentId: string) => {
    if (!agentNames.has(host.host.hostId)) {
      const known = (await deps.store.listHosts(db, host)).find(
        (candidate) => candidate.id === host.host.hostId,
      );
      if (known) learnAgents(known.id, known.agents);
    }
    return agentNames.get(host.host.hostId)?.get(agentId) ?? agentId;
  };
  const mint = async (
    host: ChatHost,
    db: ChatDb,
    turn: { threadId: ThreadId; turnId: TurnId; clientId: string; agentId: string },
  ) => {
    if (!deps.auth.delegate) {
      throw new ActionError("internal", "The auth provider cannot mint turn tokens.");
    }
    return deps.auth.delegate(host.host, {
      threadId: turn.threadId,
      turnId: turn.turnId,
      clientId: turn.clientId,
      agent: await agentNameOf(host, db, turn.agentId),
      ttlMs: deps.leaseMs,
    });
  };
  return {
    hostHello: chatAction("host", enforcing, {
      description:
        "A link's first call: agree on the host protocol and report this computer online with its agents.",
      input: z.object({
        protocols: z.object({
          min: z.number().int().min(1),
          max: z.number().int().min(1),
        }),
        hostVersion: z.string().min(1).max(32),
        name: z.string().min(1).max(80),
        platform: z.string().min(1).max(32),
        agents: z.array(agentInfoSchema).max(32),
      }),
      writes: [HOSTS_TAG],
      run: async (input, host, ctx): Promise<HostWelcome & { readonly id: string }> => {
        const id = host.host.hostId;
        const protocols = { min: MIN_HOST_PROTOCOL, max: HOST_PROTOCOL };
        const refuse = async (reason: "host_too_old" | "app_too_old") => {
          welcomed.delete(id);
          await deps.store.pruneHosts(dbOf(ctx), host, [id]);
          return { id, accepted: false as const, reason, protocols };
        };
        if (input.protocols.max < protocols.min) return refuse("host_too_old");
        const protocol = Math.min(input.protocols.max, protocols.max);
        if (protocol < input.protocols.min) return refuse("app_too_old");
        await deps.store.reportHost(dbOf(ctx), host, host.host, {
          protocol,
          name: input.name,
          platform: input.platform,
          agents: input.agents,
          online: true,
          ttlMs: 2 * deps.heartbeatMs,
        });
        learnAgents(id, input.agents);
        welcomed.add(id);
        return {
          id,
          accepted: true,
          protocol,
          leaseMs: deps.leaseMs,
          heartbeatMs: deps.heartbeatMs,
        };
      },
    }),
    hostReport: chatAction("host", enforcing, {
      description: "This computer went offline or changed its agents.",
      input: z.object({ online: z.boolean(), agents: z.array(agentInfoSchema).max(32) }),
      writes: [HOSTS_TAG],
      run: async (
        input,
        host,
        ctx,
      ): Promise<{ readonly id: string; readonly onlineUntil: number }> => {
        const db = dbOf(ctx);
        const known = await welcome(host, db);
        const { onlineUntil } = await deps.store.reportHost(db, host, host.host, {
          protocol: known.protocol,
          name: known.name,
          platform: known.platform,
          agents: input.agents,
          online: input.online,
          ttlMs: 2 * deps.heartbeatMs,
        });
        learnAgents(host.host.hostId, input.agents);
        return { id: host.host.hostId, onlineUntil };
      },
    }),
    hostClaim: chatAction("host", enforcing, {
      description:
        "Take the next turn addressed to this computer with its turn token; not_found when none waits.",
      input: z.object({}),
      run: async (_input, host, ctx): Promise<ClaimedTurn> => {
        const db = dbOf(ctx);
        await requireWelcome(host, db);
        await deps.reconcile(host);
        const claimed = await deps.transact(ctx.scope, async (tx) => {
          const taken = await deps.store.claimTurn(tx, host, host.host, deps.leaseMs);
          if (!taken) throw new ActionError("not_found", "No turn is waiting.");
          return { result: taken, threadId: taken.id };
        });
        try {
          const token = await mint(host, db, {
            threadId: claimed.id,
            turnId: claimed.turnId,
            clientId: claimed.clientId,
            agentId: claimed.agent.agentId,
          });
          const deviceId = claimed.prompt.body.signed?.deviceId;
          const [device, account, page] = await Promise.all([
            deviceId ? deps.auth.device?.(host.userId, deviceId) : undefined,
            deps.auth.account?.(host.userId),
            deps.store.readPage(db, host, claimed.id, CONTEXT_HISTORY_ITEMS),
          ]);
          const context = turnContext({
            appName: deps.appName,
            appOrigin: deps.appOrigin(ctx),
            account,
            device,
            instructions: deps.instructions,
            history: page.items.filter((item) => item.seq < claimed.prompt.seq),
          });
          return { ...claimed, device, context, token };
        } catch (error) {
          await deps
            .transact(ctx.scope, async (tx) => {
              const released = await deps.store.releaseClaim(
                tx,
                host,
                host.host,
                claimed.turnId,
              );
              return { result: released, threadId: claimed.id };
            })
            .catch(() => false);
          throw error;
        }
      },
    }),
    hostSignals: chatAction("host", enforcing, {
      description: "Answers and stop requests for the turns this computer runs.",
      input: z.object({ turns: z.array(z.object({ turnId, afterSeq })).max(16) }),
      run: async (input, host, ctx): Promise<TurnSignals[]> => {
        const db = dbOf(ctx);
        await requireWelcome(host, db);
        return deps.store.readSignals(db, host, host.host, input.turns);
      },
    }),
    hostAppend: chatAction("host", enforcing, {
      description:
        "Append finished items of a running turn and extend its lease; no items only renews it.",
      input: z.object({ turnId, items: z.array(hostItemDraft).max(64) }),
      run: async (
        input,
        host,
        ctx,
      ): Promise<{
        readonly id: string;
        readonly leaseUntil: number;
        readonly token: ClaimedTurn["token"];
      }> => {
        await requireWelcome(host, dbOf(ctx));
        const appended = await deps.transact(ctx.scope, async (tx) => {
          const result = await deps.store.appendHostItems(
            tx,
            host,
            host.host,
            input.turnId,
            input.items,
            deps.leaseMs,
          );
          return {
            result,
            threadId: input.items.length > 0 ? result.threadId : undefined,
          };
        });
        const token = await mint(host, dbOf(ctx), { ...appended, turnId: input.turnId });
        return { id: appended.threadId, leaseUntil: appended.leaseUntil, token };
      },
    }),
    hostFinish: chatAction("host", enforcing, {
      description: "End a turn, once.",
      input: z.object({
        turnId,
        outcome: z.discriminatedUnion("state", [
          z.object({ state: z.literal("done"), stopReason: z.string() }),
          z.object({ state: z.literal("cancelled") }),
          z.object({ state: z.literal("failed"), reason: z.enum(TURN_FAILURES) }),
        ]),
      }),
      run: async (input, host, ctx): Promise<{ readonly id: string }> => {
        await requireWelcome(host, dbOf(ctx));
        const finished = await deps.transact(ctx.scope, async (tx) => {
          const result = await deps.store.finishTurn(
            tx,
            host,
            host.host,
            input.turnId,
            input.outcome,
          );
          return { result, threadId: result.threadId };
        });
        deps.relay.settle(host, finished.threadId, input.turnId);
        return { id: finished.threadId };
      },
    }),
  };
}

/**
 * The chat's actions at `/_parlor/chat/actions/<name>`: plugin actions, so never on MCP
 * and never callable by an agent. Writes return the thread or host id as `id`.
 */
export function chatActions(deps: ChatActionDeps) {
  return createRegistry({ ...userChatActions(deps), ...hostChatActions(deps) });
}

export type ChatActionRegistry = ReturnType<typeof chatActions>;
export type ChatActionMap = ActionsOf<ChatActionRegistry>;
export type ChatUserActionMap = ReturnType<typeof userChatActions>;
export type ChatHostActionMap = ReturnType<typeof hostChatActions>;
