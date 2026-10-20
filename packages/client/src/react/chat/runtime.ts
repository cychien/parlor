import type { AgentConfirmation, AgentUiClient } from "@parlor/agent-ui/client";
import type { CapabilityHandle, LocalAgentHost } from "@parlor/capabilities";
import {
  CHAT_CHANNEL,
  CHAT_TAG,
  type ChatFrame,
  type ChatItem,
  foldThread,
  type HostSummary,
  HOSTS_TAG,
  isPromptTooLong,
  type LoggedItem,
  parseChatFrame,
  PROMPT_LIMIT_MESSAGE,
  type ThreadSummary,
  type TurnStatus,
} from "@parlor/chat";
import type { ChatUserActionMap } from "@parlor/chat/server";
import {
  ActionError,
  asId,
  type ItemId,
  type Tag,
  tagsOverlap,
  type ThreadId,
  type TurnId,
} from "@parlor/core";
import type { ClientChannel } from "@parlor/sync";

import { generateClientId } from "../../action-client.js";
import type { PluginClient } from "../../plugin-client.js";
import type { DeviceSource, HostAuthorizer } from "../../session.js";
import {
  applyFrame,
  mergeSnapshot,
  NO_OPEN_TURNS,
  type OpenTurns,
  pruneOpen,
} from "./open-turns.js";

/** One agent the user can talk to; `key` is `<hostId>/<agentId>`. */
export interface AgentChoice {
  readonly key: string;
  readonly name: string;
  readonly hostName: string;
  readonly online: boolean;
  readonly ready: boolean;
  readonly problem: string | undefined;
}

/** How this client adds a computer, decided by the `localAgentHost` capability. */
export type ConnectOption =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "here"; start(): Promise<void> };

/** `unavailable`: this backend has no chat, or the first read failed. */
export type ChatStatus = "loading" | "idle" | "sending" | "running" | "unavailable";

export interface ChatState {
  readonly status: ChatStatus;
  readonly thread: ThreadSummary | undefined;
  readonly threads: readonly ThreadSummary[];
  readonly items: readonly ChatItem<AgentConfirmation>[];
  readonly hosts: readonly HostSummary[];
  readonly agents: readonly AgentChoice[];
  readonly agent: AgentChoice | undefined;
  readonly connect: ConnectOption;
  readonly draft: string;
  /** Why the last send, stop or answer failed; cleared by the next one that succeeds. */
  readonly error: string | undefined;
}

export interface ChatCommands {
  setDraft(text: string): void;
  /** Signs the draft (or `text`) and sends it to the chosen agent; idempotent per call. */
  send(text?: string): Promise<void>;
  stop(): Promise<void>;
  /** A `presence` ask triggers the OS prompt first; a `computer` ask refuses. */
  answer(
    askId: string,
    choice: string,
    values?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void>;
  choose(agentKey: string): void;
  openThread(threadId: string | undefined): void;
}

export interface ChatRuntime extends ChatCommands {
  subscribe(listener: () => void): () => void;
  get(): ChatState;
  start(): () => void;
}

export interface ChatRuntimeDeps {
  readonly calls: PluginClient<ChatUserActionMap>;
  readonly clientId: string;
  readonly appOrigin: string;
  readonly agentUi: AgentUiClient;
  readonly addChannel: (channel: ClientChannel) => () => void;
  readonly onSyncTags: (listener: (tags: readonly Tag[]) => void) => () => void;
  readonly auth: Partial<DeviceSource & HostAuthorizer> | undefined;
  readonly localHost: Promise<CapabilityHandle<LocalAgentHost>>;
  readonly threadId: string | undefined;
}

export const HOST_GRANTS_TAG = "parlor_auth_hosts";

interface PendingSend {
  readonly text: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ItemId;
}

const mint = <K extends "thread" | "turn" | "item">(kind: K) =>
  asId(kind, generateClientId());

const isActive = (turn: TurnStatus) =>
  turn.state === "queued" || turn.state === "running";

const exceedsPromptLimit = (error: ActionError): boolean =>
  error.issues?.some(
    (issue) => issue.code === "too_big" && issue.path.join(".") === "prompt.text",
  ) ?? false;

const readable = (error: unknown): string => {
  if (!(error instanceof ActionError)) return "Could not reach the server.";
  if (error.issues === undefined) return error.message;
  return exceedsPromptLimit(error)
    ? PROMPT_LIMIT_MESSAGE
    : "That message could not be sent. Try again.";
};

const bySeq = (a: LoggedItem, b: LoggedItem) => a.seq - b.seq;

export function createChatRuntime(deps: ChatRuntimeDeps): ChatRuntime {
  const { calls, agentUi } = deps;
  const listeners = new Set<() => void>();

  let threadId = deps.threadId === undefined ? undefined : asId("thread", deps.threadId);
  let loaded: "no" | "yes" | "failed" = "no";
  let thread: ThreadSummary | undefined;
  let threads: readonly ThreadSummary[] = [];
  let hosts: readonly HostSummary[] = [];
  let items = new Map<string, LoggedItem>();
  let turns: readonly TurnStatus[] = [];
  let open: OpenTurns = NO_OPEN_TURNS;
  let beforeLoad: ChatFrame[] = [];
  let draft = "";
  let failure: string | undefined;
  let chosen: string | undefined;
  let sending = false;
  let pendingSend: PendingSend | undefined;
  let connect: ConnectOption = {
    kind: "command",
    command: `npx @parlor/agent-host connect ${deps.appOrigin}`,
  };
  let stopWatching: (() => void) | undefined;
  let watched: ThreadId | undefined;
  let running = false;
  let channelOpen = false;
  let staleAfterLoad = false;
  let generation = 0;
  const answerIds = new Map<string, ItemId>();
  const stopIds = new Map<TurnId, ItemId>();

  const choices = (): AgentChoice[] =>
    hosts.flatMap((host) =>
      host.agents.map((agent) => ({
        key: `${host.id}/${agent.id}`,
        name: agent.name,
        hostName: host.name,
        online: host.online,
        ready: agent.ready,
        problem: agent.problem,
      })),
    );

  const compute = (): ChatState => {
    const agents = choices();
    const wanted =
      chosen ??
      (thread?.agent ? `${thread.agent.hostId}/${thread.agent.agentId}` : undefined);
    const agent =
      agents.find((choice) => choice.key === wanted) ??
      agents.find((choice) => choice.online && choice.ready) ??
      agents[0];
    const status: ChatStatus =
      loaded === "failed"
        ? "unavailable"
        : loaded === "no"
          ? "loading"
          : sending
            ? "sending"
            : turns.some(isActive) || open.turns.size > 0
              ? "running"
              : "idle";
    return {
      status,
      thread,
      threads,
      items: foldThread({
        items: [...items.values()].sort(bySeq),
        open: [...open.turns.values()],
        turns,
        confirmations: agentUi.confirmations.get().filter((c) => c.threadId === threadId),
        deviceId: undefined,
      }),
      hosts,
      agents,
      agent,
      connect,
      draft,
      error: failure,
    };
  };

  let state = compute();
  const emit = () => {
    state = compute();
    for (const listener of [...listeners]) listener();
  };

  const watch = () => {
    if (watched === threadId) return;
    stopWatching?.();
    watched = threadId;
    stopWatching = threadId === undefined ? undefined : agentUi.watch(threadId);
  };

  const absorb = (page: {
    readonly items: readonly LoggedItem[];
    readonly turns?: readonly TurnStatus[] | undefined;
  }) => {
    items = new Map(items);
    for (const item of page.items) items.set(item.id, item);
    if (page.turns) turns = page.turns;
    open = pruneOpen(open, items, turns);
  };

  const load = async (target: ThreadId | undefined) => {
    const epoch = generation;
    const snapshot = await calls.call("open", target ? { threadId: target } : {});
    if (epoch !== generation) return;
    threads = snapshot.threads;
    hosts = snapshot.hosts;
    thread = snapshot.page.thread;
    threadId = snapshot.page.thread?.id ?? target;
    absorb(snapshot.page);
    open = mergeSnapshot(open, channelOpen ? snapshot.page.open : []);
    const replay = beforeLoad;
    beforeLoad = [];
    loaded = "yes";
    for (const frame of replay) {
      if (frame.threadId === threadId) open = applyFrame(open, frame);
    }
    open = pruneOpen(open, items, turns);
    watch();
  };

  const refreshHosts = async () => {
    const fresh = await calls.call("hosts", {});
    hosts = fresh;
    emit();
  };

  let refreshing = false;
  let refreshAgain = false;
  const refresh = async () => {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        if (loaded !== "yes" || threadId === undefined) break;
        const epoch = generation;
        const target = threadId;
        if (turns.some(isActive)) {
          await load(target);
        } else {
          const lastSeq = Math.max(0, ...[...items.values()].map((item) => item.seq));
          const fresh = await calls.call("items", {
            threadId: target,
            afterSeq: lastSeq,
          });
          if (epoch !== generation) break;
          absorb({ items: fresh });
          const known = new Set(turns.map((turn) => turn.turnId));
          if (fresh.some((item) => !known.has(item.turnId))) await load(target);
        }
        emit();
      } while (refreshAgain);
    } catch {
      refreshAgain = false;
    } finally {
      refreshing = false;
    }
  };

  const reporting = async (command: () => Promise<void>) => {
    try {
      await command();
    } catch (error) {
      failure = readable(error);
      emit();
      throw error;
    }
    if (failure !== undefined) {
      failure = undefined;
      emit();
    }
  };

  const activeTurn = (): TurnStatus | undefined => [...turns].reverse().find(isActive);

  const runtime: ChatRuntime = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    setDraft(text) {
      draft = text;
      emit();
    },
    async send(text = draft) {
      const prompt = text.trim();
      const target = state.agent;
      if (!prompt || isPromptTooLong(prompt) || !target || sending || loaded !== "yes") {
        return;
      }
      const [hostId, agentId] = target.key.split("/") as [string, string];
      const attempt =
        pendingSend?.text === prompt
          ? pendingSend
          : (pendingSend = {
              text: prompt,
              threadId: threadId ?? mint("thread"),
              turnId: mint("turn"),
              itemId: mint("item"),
            });
      sending = true;
      emit();
      try {
        await reporting(async () => {
          await calls.call("send", {
            threadId: attempt.threadId,
            turnId: attempt.turnId,
            itemId: attempt.itemId,
            clientId: deps.clientId,
            prompt: { text: prompt, agent: { hostId: asId("host", hostId), agentId } },
          });
          pendingSend = undefined;
          if (draft.trim() === prompt) draft = "";
          threadId = attempt.threadId;
          watch();
          await load(threadId);
        });
      } finally {
        sending = false;
        emit();
      }
    },
    async stop() {
      const turn = activeTurn();
      if (!turn || threadId === undefined) return;
      const itemId = stopIds.get(turn.turnId) ?? mint("item");
      stopIds.set(turn.turnId, itemId);
      const target = threadId;
      await reporting(async () => {
        await calls.call("cancel", { threadId: target, turnId: turn.turnId, itemId });
        await refresh();
      });
    },
    async answer(askId, choice, values) {
      const ask = state.items.find((item) => item.kind === "ask" && item.id === askId);
      if (!ask || ask.kind !== "ask" || ask.answer.state !== "open" || !threadId) return;
      if (ask.approval === "computer") {
        throw new Error("This question is answered on your computer.");
      }
      const itemId = answerIds.get(askId) ?? mint("item");
      answerIds.set(askId, itemId);
      const target = threadId;
      await reporting(async () => {
        await calls.call("answer", {
          threadId: target,
          turnId: ask.turnId,
          itemId,
          answer: { askId: ask.id, choice, ...(values ? { values } : {}) },
        });
        await refresh();
      });
    },
    choose(agentKey) {
      chosen = agentKey;
      emit();
    },
    openThread(target) {
      generation += 1;
      threadId = target === undefined ? undefined : asId("thread", target);
      thread = undefined;
      items = new Map();
      turns = [];
      open = NO_OPEN_TURNS;
      beforeLoad = [];
      loaded = "no";
      watch();
      emit();
      void loadFirst().then(emit);
    },
    start() {
      running = true;
      const detachChannel = deps.addChannel({
        event: CHAT_CHANNEL,
        opened: () => {
          channelOpen = true;
          if (loaded === "yes" && turns.some(isActive)) void refresh();
        },
        receive(data) {
          const frame = parseChatFrame(data);
          if (!frame) return;
          if (loaded === "no") {
            beforeLoad.push(frame);
            return;
          }
          if (loaded !== "yes" || frame.threadId !== threadId) return;
          open = applyFrame(open, frame);
          emit();
        },
        closed: () => {
          channelOpen = false;
        },
      });
      const offTags = deps.onSyncTags((tags) => {
        const mine = tags.some((tag) =>
          tagsOverlap(tag, threadId === undefined ? [CHAT_TAG] : [CHAT_TAG, threadId]),
        );
        const computers = tags.some(
          (tag) => tagsOverlap(tag, [HOSTS_TAG]) || tagsOverlap(tag, [HOST_GRANTS_TAG]),
        );
        if (loaded === "failed" && (mine || computers)) {
          void loadFirst().then(emit);
        } else if (loaded === "no") {
          staleAfterLoad = true;
        } else {
          if (mine && threadId !== undefined) void refresh();
          else if (mine) void load(undefined).then(emit, () => {});
          if (computers) void refreshHosts().catch(() => {});
        }
      });
      const offConfirmations = agentUi.confirmations.subscribe(emit);
      void initial();
      return () => {
        running = false;
        channelOpen = false;
        generation += 1;
        detachChannel();
        offTags();
        offConfirmations();
        stopWatching?.();
        stopWatching = undefined;
        watched = undefined;
      };
    },
  };

  async function loadFirst() {
    try {
      await load(threadId);
    } catch {
      if (running) loaded = "failed";
      return;
    }
    if (staleAfterLoad) {
      staleAfterLoad = false;
      await refresh();
    }
  }

  async function initial() {
    void deps.localHost.then((handle) => {
      const authorizeHost = deps.auth?.authorizeHost;
      if (!handle.available || !authorizeHost || !running) return;
      connect = {
        kind: "here",
        start: async () => {
          const outcome = await handle.api.connect({
            appOrigin: deps.appOrigin,
            authorize: authorizeHost,
          });
          if (!outcome.connected) throw new Error(`Connecting failed: ${outcome.reason}`);
          await refreshHosts();
        },
      };
      emit();
    });
    await loadFirst();
    emit();
  }

  return runtime;
}
