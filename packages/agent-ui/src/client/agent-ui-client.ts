import type { ClientChannel } from "@parlor/sync";
import type { AnyRouter } from "@tanstack/router-core";

import {
  type AgentOrigin,
  type ClientMessage,
  parseUiRequest,
  type PresenceUpdate,
  type QuerySnapshot,
  type RouteSnapshot,
  type ScreenSnapshot,
  UI_CHANNEL,
  type UiOp,
  type UiReply,
  type UiRequest,
} from "../protocol.js";
import { type BrowserEnvironment, browserEnvironment } from "./environment.js";
import { createViewRegistry, type ViewRegistry } from "./registry.js";
import { captureScreen, DEFAULT_SCREEN_LIMITS, type ScreenLimits } from "./screen.js";

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

export interface AgentActivity {
  readonly busy: boolean;
  readonly last:
    | { readonly op: UiOp; readonly origin: AgentOrigin; readonly at: number }
    | undefined;
}

export interface ActivityStore {
  subscribe(listener: () => void): () => void;
  get(): AgentActivity;
}

export interface AgentUiClient extends ClientChannel {
  readonly views: ViewRegistry;
  readonly activity: ActivityStore;
  screen(): Promise<ScreenSnapshot>;
  start(): () => void;
}

const REPLY_CACHE_SIZE = 64;
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
  end(): void;
  watched(): boolean;
} {
  const listeners = new Set<() => void>();
  let state: AgentActivity = { busy: false, last: undefined };
  const set = (next: AgentActivity) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    begin: (request, at) =>
      set({ busy: true, last: { op: request.op, origin: request.origin, at } }),
    end: () => set({ ...state, busy: false }),
    watched: () => listeners.size > 0,
  };
}

export function createAgentUiClient(options: AgentUiClientOptions): AgentUiClient {
  const env = options.environment ?? browserEnvironment();
  const limits = { ...DEFAULT_SCREEN_LIMITS, ...options.limits };
  const registry = createViewRegistry(env);
  const activity = createActivityStore();
  const replies = new Map<string, UiReply>();
  const queued = new Set<string>();
  const queue: UiRequest[] = [];
  let draining = false;
  let warnedUnwatched = false;

  const post = (message: ClientMessage) =>
    void options.send(message).then(
      (next) => {
        if (next !== undefined) receive(next);
      },
      () => {},
    );

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

  const execute = async (request: UiRequest): Promise<UiReply> => {
    try {
      switch (request.op) {
        case "screen":
          return { type: "reply", id: request.id, ok: true, result: await screen() };
        case "navigate":
          throw new Error("not implemented");
      }
    } catch (error) {
      return {
        type: "reply",
        id: request.id,
        ok: false,
        error: {
          code: "internal",
          message: error instanceof Error ? error.message : "The app failed to answer.",
        },
      };
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
      activity.end();
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

  let lastPresence: string | undefined;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const presence = (): PresenceUpdate => {
    const visible = env.document?.visibilityState === "visible";
    return {
      type: "presence",
      focused: visible && (env.document?.hasFocus() ?? false),
      visible,
      platform: options.platform,
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
    };
  };
  const reportPresence = () => {
    const update = presence();
    const serialized = JSON.stringify(update);
    if (serialized === lastPresence) return;
    lastPresence = serialized;
    post(update);
  };
  const schedulePresence = () => {
    if (presenceTimer !== undefined) return;
    presenceTimer = env.setTimeout(() => {
      presenceTimer = undefined;
      reportPresence();
    }, 0);
  };
  const leave = () => post({ type: "leave" });
  const presenceTargets = () =>
    [
      [env.window, "focus", schedulePresence],
      [env.window, "blur", schedulePresence],
      [env.window, "pageshow", schedulePresence],
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
    const parsed = parseUiRequest(data);
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
    const { request } = parsed;
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
    views: registry,
    activity,
    screen,
    opened() {
      attachPresence();
      lastPresence = undefined;
      reportPresence();
    },
    closed: detachPresence,
    receive,
    start() {
      registry.resume();
      return () => {
        registry.dispose();
        detachPresence();
      };
    },
  };
}
