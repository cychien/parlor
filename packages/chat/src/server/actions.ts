import type { ActionContext } from "@parlor/core";
import { type ActionsOf, createRegistry } from "@parlor/core/registry";
import type { AuthProvider } from "@parlor/server";
import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import { chatItemBodies, hostItemDraft, type LoggedItem } from "../items.js";
import type {
  ChatSnapshot,
  ClaimedTurn,
  HostSummary,
  TurnFailure,
  TurnSignals,
} from "../model.js";
import type { HostWelcome } from "../protocol.js";
import type { LiveRelay } from "./live.js";
import { chatAction } from "./party.js";
import type { ChatStore } from "./store.js";

/** Every chat write emits `["parlor_chat", threadId]`, the one event that wakes hosts and other devices. */
export const CHAT_TAG = "parlor_chat";
export const HOSTS_TAG = "parlor_chat_hosts";

export interface ChatActionDeps {
  readonly enforcing: boolean;
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

const agentInfo = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.string().optional(),
  ready: z.boolean(),
  problem: z.string().optional(),
});

const TURN_FAILURES = [
  "agent_exited",
  "agent_unavailable",
  "device_rejected",
  "signature_invalid",
  "prompt_expired",
  "host_lost",
] as const satisfies readonly TurnFailure[];

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/** What the user's devices call. */
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
      ],
      // TODO: one read: store.listThreads, store.listHosts, store.readPage(threadId ?? newest);
      //   page.open = deps.relay.open(owner, page.thread.id).
      run: (): ChatSnapshot => notImplemented(),
    }),
    items: chatAction("user", enforcing, {
      description: "A thread's items after a sequence number.",
      input: z.object({ threadId, afterSeq }),
      reads: (input) => [[CHAT_TAG, input.threadId]],
      run: (): LoggedItem[] => notImplemented(),
    }),
    hosts: chatAction("user", enforcing, {
      description: "The user's computers and the agents on them.",
      input: z.object({}),
      reads: [HOSTS_TAG],
      run: (): HostSummary[] => notImplemented(),
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
      writes: [CHAT_TAG],
      // TODO: refuse when prompt.agent.hostId is not one of the owner's live hosts, or the
      //   thread already queues deps.maxQueued turns; store.appendUserItems with the turn.
      run: (): { readonly id: string; readonly turnId: string } => notImplemented(),
    }),
    answer: chatAction("user", enforcing, {
      description: "Answer the agent's permission prompt or question.",
      input: z.object({ threadId, turnId, itemId, answer: chatItemBodies.answer.body }),
      writes: [CHAT_TAG],
      run: (): { readonly id: string } => notImplemented(),
    }),
    cancel: chatAction("user", enforcing, {
      description: "Stop the running turn; what the agent already said is kept.",
      input: z.object({ threadId, turnId, itemId }),
      writes: [CHAT_TAG],
      run: (): { readonly id: string } => notImplemented(),
    }),
  };
}

/** What the user's computers call; `hostHello` first on every link. */
export function hostChatActions(deps: ChatActionDeps) {
  const { enforcing } = deps;
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
        agents: z.array(agentInfo).max(32),
      }),
      writes: [HOSTS_TAG],
      // TODO: protocol = min(input.protocols.max, HOST_PROTOCOL); below either side's min ->
      //   { accepted: false, reason }; else store.reportHost and { accepted: true, protocol,
      //   leaseMs, heartbeatMs }. Other host actions refuse a host never welcomed.
      run: (): HostWelcome & { readonly id: string } => notImplemented(),
    }),
    hostReport: chatAction("host", enforcing, {
      description: "This computer went offline or changed its agents.",
      input: z.object({ online: z.boolean(), agents: z.array(agentInfo).max(32) }),
      writes: [HOSTS_TAG],
      run: (): { readonly id: string; readonly onlineUntil: number } => notImplemented(),
    }),
    hostClaim: chatAction("host", enforcing, {
      description:
        "Take the next turn addressed to this computer with its turn token; not_found when none waits.",
      input: z.object({}),
      writes: [CHAT_TAG],
      // TODO: store.claimTurn (none -> ActionError not_found, which rolls back: no sync
      //   event); token = deps.auth.delegate(host, { threadId, turnId, clientId, agent,
      //   ttlMs: leaseMs }); device = deps.auth.device(userId, prompt.signed.deviceId);
      //   context = turnContext({ appName, appOrigin, account: deps.auth.account(userId),
      //   device, instructions, history: items before the prompt }).
      run: (): ClaimedTurn => notImplemented(),
    }),
    hostSignals: chatAction("host", enforcing, {
      description: "Answers and stop requests for the turns this computer runs.",
      input: z.object({ turns: z.array(z.object({ turnId, afterSeq })).max(16) }),
      run: (): TurnSignals[] => notImplemented(),
    }),
    hostAppend: chatAction("host", enforcing, {
      description: "Append finished items of a running turn and extend its lease.",
      input: z.object({ turnId, items: z.array(hostItemDraft).min(1).max(64) }),
      writes: [CHAT_TAG],
      // TODO: store.appendHostItems; renew the token with deps.auth.delegate.
      run: (): {
        readonly id: string;
        readonly leaseUntil: number;
        readonly token: ClaimedTurn["token"];
      } => notImplemented(),
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
      writes: [CHAT_TAG],
      // TODO: store.finishTurn; deps.relay.settle(owner, threadId, turnId).
      run: (): { readonly id: string } => notImplemented(),
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
