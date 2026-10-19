import type { ClientChannel } from "@parlor/sync";
import type { AnyRouter } from "@tanstack/router-core";

import {
  type AgentOrigin,
  type ClientMessage,
  MAX_WATCHED_THREADS,
  parseUiFrame,
  type PresenceUpdate,
  type QuerySnapshot,
  type RouteSnapshot,
  type ScreenSnapshot,
  UI_CHANNEL,
  UI_OPS,
  type UiError,
  type UiErrorCode,
  type UiOp,
  type UiOpInput,
  type UiReply,
  type UiRequest,
} from "../protocol.js";
import { type AnyAgentView } from "../view.js";
import { type ConfirmationStore, createConfirmationStore } from "./confirmations.js";
import { type BrowserEnvironment, browserEnvironment } from "./environment.js";
import { createHighlightMarks, highlightView } from "./highlight.js";
import { createViewRegistry, type ViewRegistry, type ViewSlot } from "./registry.js";
import { captureScreen, DEFAULT_SCREEN_LIMITS, type ScreenLimits } from "./screen.js";
import { setView } from "./write.js";

export interface QuerySource {
  active(): readonly QuerySnapshot[];
  settled(timeoutMs: number): Promise<void>;
}

export interface AgentUiClientOptions {
  readonly router?: AnyRouter | undefined;
  readonly queries: QuerySource;
  readonly send: (message: ClientMessage) => Promise<string | undefined>;
  readonly platform: string;
  readonly buildId?: string | undefined;
  readonly environment?: BrowserEnvironment | undefined;
  readonly limits?: Partial<ScreenLimits> | undefined;
  readonly settleMs?: number | undefined;
  readonly dev?: boolean | undefined;
}

/** What an agent is doing on this screen: a UI op, or waiting for the user to confirm. */
export type AgentActivityKind = UiOp | "confirm";

/** How the app answered an operation: it did it, or refused with the error code the agent got. */
export type AgentOutcome =
  | { readonly status: "done" }
  | { readonly status: "refused"; readonly code: UiErrorCode };

export interface AgentActivity {
  /** A request is running, or a confirmation card is waiting for the user on this client. */
  readonly busy: boolean;
  readonly last:
    | {
        readonly op: AgentActivityKind;
        readonly origin: AgentOrigin;
        readonly at: number;
        /** Undefined while the operation runs, and for `confirm`, which the user answers. */
        readonly outcome?: AgentOutcome | undefined;
      }
    | undefined;
}

export interface ActivityStore {
  subscribe(listener: () => void): () => void;
  get(): AgentActivity;
}

export interface AgentUiClient extends ClientChannel {
  readonly views: ViewRegistry;
  readonly activity: ActivityStore;
  readonly confirmations: ConfirmationStore;
  screen(): Promise<ScreenSnapshot>;
  start(): () => void;
  /** Declares a chat thread shown here until the returned function runs (presence `watching`). */
  watch(threadId: string): () => void;
}

const REPLY_CACHE_SIZE = 64;
const DEFAULT_SETTLE_MS = 1500;
const OBSERVER_WAIT_MS = 100;

export function routeSnapshot(router: AnyRouter): RouteSnapshot | null {
  const { matches, location } = router.state;
  const leaf = matches.at(-1);
  if (!leaf) return null;
  if (matches.some((match) => match._notFound)) {
    return { notFound: true, url: location.href };
  }
  return {
    notFound: false,
    path: leaf.fullPath,
    params: leaf.params as Record<string, string>,
    search: location.search as Record<string, unknown>,
    url: location.href,
  };
}

function createActivityStore(): ActivityStore & {
  begin(request: UiRequest, at: number): void;
  end(reply: UiReply): void;
  confirming(
    pending: number,
    arrived: { readonly origin: AgentOrigin; readonly at: number } | undefined,
  ): void;
  watched(): boolean;
} {
  const listeners = new Set<() => void>();
  let running = false;
  let pending = 0;
  let last: AgentActivity["last"];
  let state: AgentActivity = { busy: false, last: undefined };
  const publish = () => {
    state = { busy: running || pending > 0, last };
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    begin(request, at) {
      running = true;
      last = { op: request.op, origin: request.origin, at, outcome: undefined };
      publish();
    },
    end(reply) {
      running = false;
      if (last && last.op !== "confirm") {
        last = {
          ...last,
          outcome: reply.ok
            ? { status: "done" }
            : { status: "refused", code: reply.error.code },
        };
      }
      publish();
    },
    confirming(count, arrived) {
      pending = count;
      if (arrived) last = { op: "confirm", origin: arrived.origin, at: arrived.at };
      publish();
    },
    watched: () => listeners.size > 0,
  };
}

export function createAgentUiClient(options: AgentUiClientOptions): AgentUiClient {
  const env = options.environment ?? browserEnvironment();
  const limits = { ...DEFAULT_SCREEN_LIMITS, ...options.limits };
  const registry = createViewRegistry(env);
  const unlistedWarned = new Set<string>();
  const warnIfUnlisted = (view: AnyAgentView) => {
    const router = options.router;
    if (!options.dev || !router || unlistedWarned.has(view.name)) return;
    const matches = router.state.matches;
    if (matches.some((match) => match.staticData?.views?.includes(view))) return;
    unlistedWarned.add(view.name);
    console.warn(
      `[parlor] The agent view "${view.name}" mounted on ${router.state.location.pathname}, but no matched route lists it in staticData.views, so the manifest cannot tell agents where it lives.`,
    );
  };
  const views: ViewRegistry = {
    track(view, binding) {
      const slot = registry.track(view, binding);
      return {
        ...slot,
        mount(key) {
          warnIfUnlisted(view);
          return slot.mount(key);
        },
      } satisfies ViewSlot;
    },
  };
  const activity = createActivityStore();
  const marks = createHighlightMarks(env);
  const confirmations = createConfirmationStore({
    env,
    answer: (id, approve) => post({ type: "answer", id, approve }),
    onWatchedChange: () => schedulePresence(),
    onChange: () => {
      const showing = confirmations.get();
      const arrived = showing.filter((item) => !seenCards.has(item.id)).at(-1);
      for (const item of showing) seenCards.add(item.id);
      activity.confirming(
        showing.length,
        arrived && { origin: arrived.origin, at: env.now() },
      );
    },
  });
  const seenCards = new Set<string>();
  const replies = new Map<string, UiReply>();
  const queued = new Set<string>();
  const queue: UiRequest[] = [];
  let draining = false;
  let warnedUnwatched = false;

  const deliver = (message: ClientMessage): Promise<void> =>
    options.send(message).then(
      (next) => {
        if (next !== undefined) receive(next);
      },
      () => {},
    );
  const post = (message: ClientMessage) => void deliver(message);

  let lifecycleTail: Promise<void> | undefined;
  const postInOrder = (message: ClientMessage) => {
    const delivered =
      lifecycleTail === undefined
        ? deliver(message)
        : lifecycleTail.then(() => deliver(message));
    const tail: Promise<void> = delivered.finally(() => {
      if (lifecycleTail === tail) lifecycleTail = undefined;
    });
    lifecycleTail = tail;
  };

  const observed = async () => {
    // A hidden page does not render, so its observer stays silent until it is shown.
    if (!registry.awaitingObserver() || env.document?.visibilityState !== "visible") {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      registry.observed(),
      new Promise<void>((resolve) => {
        timer = env.setTimeout(resolve, OBSERVER_WAIT_MS);
      }),
    ]);
    env.clearTimeout(timer);
  };

  const screen = async () => {
    await observed();
    return captureScreen(
      registry,
      {
        route: () => (options.router ? routeSnapshot(options.router) : null),
        queries: () => options.queries.active(),
      },
      env,
      limits,
    );
  };

  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  const navigate = async (
    input: UiOpInput<"navigate">,
  ): Promise<ScreenSnapshot | UiError> => {
    const router = options.router;
    if (!router) {
      return {
        code: "unknown_route",
        message:
          "This app did not give FrameworkProvider a router, so it cannot navigate.",
      };
    }
    if (!Object.hasOwn(router.routesByPath, input.to)) {
      return { code: "unknown_route", message: `This app has no route ${input.to}.` };
    }
    const deadline = env.now() + settleMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      router.navigate({
        to: input.to,
        ...(input.params ? { params: input.params } : {}),
        ...(input.search ? { search: input.search } : {}),
        ...(input.replace === undefined ? {} : { replace: input.replace }),
      } as unknown as Parameters<AnyRouter["navigate"]>[0]),
      new Promise<void>((resolve) => {
        timer = env.setTimeout(resolve, settleMs);
      }),
    ]);
    env.clearTimeout(timer);
    await env.nextTask();
    await options.queries.settled(Math.max(0, deadline - env.now()));
    await env.nextTask();
    return screen();
  };

  const execute = async (request: UiRequest): Promise<UiReply> => {
    const ok = (result: unknown): UiReply => ({
      type: "reply",
      id: request.id,
      ok: true,
      result,
    });
    const fail = (error: UiError): UiReply => ({
      type: "reply",
      id: request.id,
      ok: false,
      error,
    });
    try {
      switch (request.op) {
        case "screen":
          return ok(await screen());
        case "navigate": {
          const outcome = await navigate(request.input);
          return "code" in outcome ? fail(outcome) : ok({ screen: outcome });
        }
        case "set": {
          const outcome = await setView(registry, request.input, env);
          return "code" in outcome ? fail(outcome) : ok(outcome);
        }
        case "highlight": {
          const outcome = await highlightView(registry, request.input, env, marks);
          return "code" in outcome ? fail(outcome) : ok(outcome);
        }
      }
    } catch (error) {
      return fail({
        code: "internal",
        message: error instanceof Error ? error.message : "The app failed to answer.",
      });
    }
  };

  const remember = (reply: UiReply) => {
    replies.set(reply.id, reply);
    if (replies.size > REPLY_CACHE_SIZE) replies.delete(replies.keys().next().value!);
    post(reply);
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const request = queue.shift()!;
      activity.begin(request, env.now());
      const reply = await execute(request);
      queued.delete(request.id);
      remember(reply);
      activity.end(reply);
    }
    draining = false;
  };

  const warnIfUnwatched = () => {
    if (!options.dev || warnedUnwatched || activity.watched()) return;
    warnedUnwatched = true;
    console.warn(
      "[parlor] An agent is reading or driving this screen, but nothing renders useAgentActivity(). Show users when an agent is at work by building an indicator on useAgentActivity().",
    );
  };

  const watched = new Map<string, number>();
  let lastPresence: string | undefined;
  let gone = false;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const presence = (): PresenceUpdate => {
    const visible = env.document?.visibilityState === "visible";
    return {
      type: "presence",
      focused: visible && (env.document?.hasFocus() ?? false),
      visible,
      platform: options.platform,
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      ops: UI_OPS,
      canConfirm: confirmations.watched(),
      ...(watched.size > 0
        ? { watching: [...watched.keys()].slice(0, MAX_WATCHED_THREADS) }
        : {}),
    };
  };
  const reportPresence = () => {
    if (gone) return;
    const update = presence();
    const serialized = JSON.stringify(update);
    if (serialized === lastPresence) return;
    lastPresence = serialized;
    postInOrder(update);
  };
  const schedulePresence = () => {
    if (presenceTimer !== undefined) return;
    presenceTimer = env.setTimeout(() => {
      presenceTimer = undefined;
      reportPresence();
    }, 0);
  };
  const leave = () => {
    gone = true;
    lastPresence = undefined;
    if (presenceTimer !== undefined) env.clearTimeout(presenceTimer);
    presenceTimer = undefined;
    postInOrder({ type: "leave" });
  };
  const resume = () => {
    gone = false;
    schedulePresence();
  };
  const presenceTargets = () =>
    [
      [env.window, "focus", schedulePresence],
      [env.window, "blur", schedulePresence],
      [env.window, "pageshow", resume],
      [env.window, "pagehide", leave],
      [env.document, "visibilitychange", schedulePresence],
    ] as const;
  let presenceAttached = false;
  const attachPresence = () => {
    if (presenceAttached) return;
    presenceAttached = true;
    for (const [target, event, listener] of presenceTargets()) {
      target?.addEventListener(event, listener);
    }
  };
  const detachPresence = () => {
    presenceAttached = false;
    for (const [target, event, listener] of presenceTargets()) {
      target?.removeEventListener(event, listener);
    }
    if (presenceTimer !== undefined) env.clearTimeout(presenceTimer);
    presenceTimer = undefined;
    lastPresence = undefined;
  };

  const receive = (data: string) => {
    const parsed = parseUiFrame(data);
    if (!parsed.ok) {
      if (parsed.id !== undefined) {
        remember({
          type: "reply",
          id: parsed.id,
          ok: false,
          error: {
            code: "internal",
            message: "The app could not read this UI request.",
          },
        });
      }
      return;
    }
    const { frame: request } = parsed;
    if (!("op" in request)) {
      confirmations.replace(request.items);
      return;
    }
    const cached = replies.get(request.id);
    if (cached) {
      post(cached);
      return;
    }
    if (queued.has(request.id)) return;
    warnIfUnwatched();
    queued.add(request.id);
    queue.push(request);
    void drain();
  };

  return {
    event: UI_CHANNEL,
    views,
    activity,
    confirmations,
    screen,
    opened() {
      gone = false;
      attachPresence();
      lastPresence = undefined;
      reportPresence();
    },
    closed: detachPresence,
    receive,
    watch(threadId) {
      watched.set(threadId, (watched.get(threadId) ?? 0) + 1);
      schedulePresence();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (watched.get(threadId) ?? 1) - 1;
        if (remaining > 0) watched.set(threadId, remaining);
        else watched.delete(threadId);
        schedulePresence();
      };
    },
    start() {
      registry.resume();
      return () => {
        registry.dispose();
        marks.dispose();
        confirmations.dispose();
        detachPresence();
      };
    },
  };
}
