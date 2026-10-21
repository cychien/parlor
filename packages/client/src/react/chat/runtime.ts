import type { AgentConfirmation, AgentUiClient } from "@parlor/agent-ui/client";
import type { CapabilityHandle, LocalAgentHost } from "@parlor/capabilities";
import {
  CHAT_CHANNEL,
  CHAT_TAG,
  type ChatFrame,
  type AnswerToSign,
  type ChatItem,
  foldThread,
  type HostSummary,
  HOSTS_TAG,
  isPromptTooLong,
  type ItemSignature,
  type LoggedItem,
  parseChatFrame,
  PROMPT_LIMIT_MESSAGE,
  type PromptToSign,
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
import type { DeviceSource, HostAuthorizer, SessionDevice } from "../../session.js";
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

/**
 * `waiting`: a prompt waits for a computer, which `ChatState.wait` names: one that must
 * still approve this device, or one that is offline while the prompt queues.
 * `unavailable`: this backend has no chat, or the first read failed and is being retried.
 */
export type ChatStatus =
  | "loading"
  | "idle"
  | "sending"
  | "waiting"
  | "running"
  | "unavailable";

export interface ChatWait {
  readonly reason: "offline" | "approval";
  readonly hostId: string;
  readonly hostName: string;
}

export interface ChatState {
  readonly status: ChatStatus;
  /** Set exactly while `status` is `waiting`; approval wins when both reasons hold. */
  readonly wait: ChatWait | undefined;
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
  /** Sends a prompt again as a new turn in its thread, signed anew. */
  resend(promptItemId: string): Promise<void>;
  /** A `presence` ask triggers the OS prompt first; a `computer` ask refuses. */
  answer(
    askId: string,
    choice: string,
    values?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void>;
  choose(agentKey: string): void;
  /** `undefined` opens the most recent thread, if there is one. */
  openThread(threadId: string | undefined): void;
  /** Starts a blank thread; it exists on the server once the first prompt is sent. */
  newThread(): void;
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
  readonly onResume: (listener: () => void) => () => void;
  /** What the server negotiated for sync; `undefined` until it has. */
  readonly transport: () => "sse" | "poll" | undefined;
  readonly isHidden?: (() => boolean) | undefined;
  readonly auth: Partial<DeviceSource & HostAuthorizer> | undefined;
  readonly localHost: Promise<CapabilityHandle<LocalAgentHost>>;
  readonly threadId: string | undefined;
}

export const HOST_GRANTS_TAG = "parlor_auth_hosts";

const READ_RETRY_BASE_MS = 1_000;
const READ_RETRY_MAX_MS = 30_000;
const ACTIVITY_PING_MS = 60_000;
const UNFIXABLE_BY_RETRY: ReadonlySet<string> = new Set([
  "not_found",
  "unauthenticated",
  "forbidden",
]);

const retryable = (error: unknown) =>
  !(error instanceof ActionError && UNFIXABLE_BY_RETRY.has(error.code));

interface PendingSend {
  readonly text: string;
  readonly agent: string;
  readonly openedIn: ThreadId | undefined;
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

class NeedsDevice extends Error {
  override readonly name = "NeedsDevice";
}

const readable = (error: unknown): string => {
  if (error instanceof NeedsDevice) return error.message;
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "The presence check was cancelled.";
  }
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
  let startedNew = false;
  let connect: ConnectOption = {
    kind: "command",
    command: `npx @parlor/agent-host connect ${deps.appOrigin}`,
  };
  let stopWatching: (() => void) | undefined;
  let watched: ThreadId | undefined;
  let running = false;
  let channelOpen = false;
  let staleAfterLoad = false;
  let dirty = false;
  let unfixable = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = READ_RETRY_BASE_MS;
  let lastPing: number | undefined;
  let pingRefused = false;
  let generation = 0;
  let device: SessionDevice | undefined;
  const resends = new Map<ItemId, PendingSend>();
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

  const waitOn = (reason: ChatWait["reason"], hostId: string): ChatWait => ({
    reason,
    hostId,
    hostName: hosts.find((host) => host.id === hostId)?.name ?? "your computer",
  });

  const waitOf = (): ChatWait | undefined => {
    const approving = turns.find(awaitsApproval);
    if (approving) return waitOn("approval", approving.agent.hostId);
    const offline = turns.find(
      (turn) =>
        turn.state === "queued" &&
        hosts.some((host) => host.id === turn.agent.hostId && !host.online),
    );
    return offline && waitOn("offline", offline.agent.hostId);
  };

  const compute = (): ChatState => {
    const agents = choices();
    const wanted =
      chosen ??
      (thread?.agent ? `${thread.agent.hostId}/${thread.agent.agentId}` : undefined);
    const agent =
      agents.find((choice) => choice.key === wanted) ??
      agents.find((choice) => choice.online && choice.ready) ??
      agents[0];
    const wait = loaded === "yes" && !sending ? waitOf() : undefined;
    const status: ChatStatus =
      loaded === "failed"
        ? "unavailable"
        : loaded === "no"
          ? "loading"
          : sending
            ? "sending"
            : wait
              ? "waiting"
              : turns.some(isActive) || open.turns.size > 0
                ? "running"
                : "idle";
    return {
      status,
      wait,
      thread,
      threads,
      items: foldThread({
        items: [...items.values()].sort(bySeq),
        open: [...open.turns.values()],
        turns,
        confirmations: agentUi.confirmations.get().filter((c) => c.threadId === threadId),
        deviceId: device?.id,
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
    const page = startedNew && target === undefined ? undefined : snapshot.page;
    thread = page?.thread;
    threadId = page?.thread?.id ?? target;
    if (page) absorb(page);
    open = mergeSnapshot(open, channelOpen && page ? page.open : []);
    const replay = beforeLoad;
    beforeLoad = [];
    loaded = "yes";
    retryDelay = READ_RETRY_BASE_MS;
    for (const frame of replay) {
      if (frame.threadId === threadId) open = applyFrame(open, frame);
    }
    open = pruneOpen(open, items, turns);
    watch();
  };

  const refreshLists = async () => {
    const epoch = generation;
    const fresh = await calls.call("open", {});
    if (epoch !== generation || threadId !== undefined) return;
    threads = fresh.threads;
    hosts = fresh.hosts;
    emit();
  };

  const refreshHosts = async () => {
    const fresh = await calls.call("hosts", {});
    hosts = fresh;
    emit();
  };

  const cancelRetry = () => {
    if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const clearRetry = () => {
    cancelRetry();
    retryDelay = READ_RETRY_BASE_MS;
  };

  const scheduleRetry = () => {
    if (!running || retryTimer !== undefined) return;
    const wait = retryDelay;
    retryDelay = Math.min(retryDelay * 2, READ_RETRY_MAX_MS);
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = undefined;
      void mend();
    }, wait);
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
        dirty = false;
        clearRetry();
        emit();
      } while (refreshAgain);
    } catch (error) {
      refreshAgain = false;
      dirty = true;
      if (retryable(error)) scheduleRetry();
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

  const awaitsApproval = (turn: TurnStatus): boolean => {
    if (!isActive(turn)) return false;
    let waiting = false;
    for (const item of [...items.values()].sort(bySeq)) {
      if (item.turnId !== turn.turnId) continue;
      if (item.kind === "event" && item.body.event === "device_pending") waiting = true;
      else if (item.author !== "user") waiting = false;
    }
    return waiting;
  };

  const deviceOf = async (): Promise<SessionDevice | undefined> => {
    const found = await deps.auth?.device?.();
    device = found ?? device;
    return found;
  };

  const signPrompt = async (prompt: PromptToSign): Promise<ItemSignature | undefined> =>
    (await deviceOf())?.signPrompt(prompt);

  const submit = async (
    attempt: PendingSend,
    agentKey: string,
    settle: () => void,
  ): Promise<void> => {
    const [hostId, agentId] = agentKey.split("/") as [string, string];
    const epoch = generation;
    sending = true;
    emit();
    try {
      await reporting(async () => {
        const agent = { hostId: asId("host", hostId), agentId };
        const signed = deps.auth?.device
          ? await signPrompt({
              threadId: attempt.threadId,
              turnId: attempt.turnId,
              agent,
              text: attempt.text,
            })
          : undefined;
        await calls.call("send", {
          threadId: attempt.threadId,
          turnId: attempt.turnId,
          itemId: attempt.itemId,
          clientId: deps.clientId,
          prompt: { text: attempt.text, agent, ...(signed ? { signed } : {}) },
        });
        settle();
        if (epoch !== generation) return;
        startedNew = false;
        threadId = attempt.threadId;
        watch();
        await load(threadId);
      });
    } finally {
      sending = false;
      emit();
    }
  };

  const activeTurn = (): TurnStatus | undefined => [...turns].reverse().find(isActive);

  const switchTo = (target: ThreadId | undefined, blank: boolean) => {
    generation += 1;
    threadId = target;
    startedNew = blank;
    thread = undefined;
    items = new Map();
    turns = [];
    open = NO_OPEN_TURNS;
    beforeLoad = [];
    pendingSend = undefined;
    stopIds.clear();
    answerIds.clear();
    dirty = false;
    clearRetry();
    watch();
    if (blank && loaded === "yes") {
      emit();
      return;
    }
    loaded = "no";
    emit();
    void loadFirst().then(emit);
  };

  const runtime: ChatRuntime = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    setDraft(text) {
      draft = text;
      emit();
      announceActivity();
    },
    async send(text = draft) {
      announceActivity();
      const prompt = text.trim();
      const target = state.agent;
      if (!prompt || isPromptTooLong(prompt) || !target || sending || loaded !== "yes") {
        return;
      }
      const retrying =
        pendingSend?.text === prompt &&
        pendingSend.agent === target.key &&
        pendingSend.openedIn === threadId;
      const attempt =
        retrying && pendingSend
          ? pendingSend
          : (pendingSend = {
              text: prompt,
              agent: target.key,
              openedIn: threadId,
              threadId: threadId ?? mint("thread"),
              turnId: mint("turn"),
              itemId: mint("item"),
            });
      await submit(attempt, target.key, () => {
        pendingSend = undefined;
        if (draft.trim() === prompt) draft = "";
      });
    },
    async resend(promptItemId) {
      const prompt = state.items.find(
        (item) => item.kind === "prompt" && item.id === promptItemId,
      );
      if (prompt?.kind !== "prompt" || sending || loaded !== "yes" || !threadId) return;
      const key = `${prompt.agent.hostId}/${prompt.agent.agentId}`;
      let attempt = resends.get(prompt.id);
      if (!attempt) {
        attempt = {
          text: prompt.text,
          agent: key,
          openedIn: threadId,
          threadId,
          turnId: mint("turn"),
          itemId: mint("item"),
        };
        resends.set(prompt.id, attempt);
      }
      await submit(attempt, key, () => resends.delete(prompt.id));
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
      const toSign: AnswerToSign = {
        threadId: target,
        askId: ask.id,
        choice,
        ...(values ? { values } : {}),
      };
      await reporting(async () => {
        const found = deps.auth?.device ? await deviceOf() : undefined;
        if (ask.approval === "presence" && !found) {
          throw new NeedsDevice(
            "This question needs a device that can confirm it is you.",
          );
        }
        const signed = await found?.signAnswer(toSign, {
          presence: ask.approval === "presence",
        });
        await calls.call("answer", {
          threadId: target,
          turnId: ask.turnId,
          itemId,
          answer: {
            askId: ask.id,
            choice,
            ...(values ? { values } : {}),
            ...(signed ? { signed } : {}),
          },
        });
        answerIds.delete(askId);
        await refresh();
      });
    },
    choose(agentKey) {
      chosen = agentKey;
      emit();
    },
    openThread(target) {
      switchTo(target === undefined ? undefined : asId("thread", target), false);
    },
    newThread() {
      switchTo(undefined, true);
    },
    start() {
      running = true;
      const detachChannel = deps.addChannel({
        event: CHAT_CHANNEL,
        opened: () => {
          channelOpen = true;
          if (loaded === "yes" && turns.some(isActive) && !refreshing) void refresh();
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
          cancelRetry();
          void loadFirst().then(emit);
        } else if (loaded === "no") {
          if (mine || computers) staleAfterLoad = true;
        } else {
          if (mine && threadId !== undefined) void refresh();
          else if (mine && !startedNew && draft.trim() === "") {
            void load(undefined).then(emit, () => {});
          } else if (mine) void refreshLists().catch(() => {});
          if (computers) void refreshHosts().catch(() => {});
        }
      });
      const offResume = deps.onResume(() => {
        if (loaded === "failed") {
          if (!unfixable) {
            cancelRetry();
            void loadFirst().then(emit);
          }
        } else if (loaded === "no") staleAfterLoad = true;
        else void refresh();
      });
      const offConfirmations = agentUi.confirmations.subscribe(emit);
      emit();
      announceActivity();
      void initial();
      return () => {
        running = false;
        channelOpen = false;
        generation += 1;
        clearRetry();
        detachChannel();
        offTags();
        offResume();
        offConfirmations();
        stopWatching?.();
        stopWatching = undefined;
        watched = undefined;
      };
    },
  };

  async function mend() {
    if (loaded === "failed") await loadFirst();
    else if (loaded === "yes" && dirty) await refresh();
    emit();
  }

  function announceActivity() {
    if (!running || pingRefused || deps.transport() !== "poll") return;
    if (deps.isHidden?.() === true) return;
    const now = Date.now();
    if (lastPing !== undefined && now - lastPing < ACTIVITY_PING_MS) return;
    lastPing = now;
    calls.call("userActive", {}).catch((error: unknown) => {
      if (error instanceof ActionError && error.code === "not_found") pingRefused = true;
    });
  }

  async function loadFirst() {
    try {
      await load(threadId);
      unfixable = false;
    } catch (error) {
      if (running) {
        loaded = "failed";
        unfixable = !retryable(error);
        if (!unfixable) scheduleRetry();
      }
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
          const own = await deps.auth?.device?.();
          const outcome = await handle.api.connect({
            appOrigin: deps.appOrigin,
            authorize: authorizeHost,
            ...(own ? { device: own.keys } : {}),
          });
          if (!outcome.connected) throw new Error(`Connecting failed: ${outcome.reason}`);
          await refreshHosts();
        },
      };
      emit();
    });
    await loadFirst();
    announceActivity();
    emit();
  }

  return runtime;
}
