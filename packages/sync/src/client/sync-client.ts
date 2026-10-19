import type { ClientChannel } from "../channel.js";
import {
  compareCursors,
  cursorOf,
  decodeCursor,
  encodeCursor,
  INITIAL_CURSOR,
  LEGACY_KEEP_ALIVE_MS,
  type SyncBatch,
  type SyncCursor,
  type SyncEvent,
  type SyncNegotiation,
  streamLivenessMs,
} from "../protocol.js";
import { readSse } from "./sse.js";

export type SyncRequest = (path: string, init?: RequestInit) => Promise<Response>;

export interface SyncClientOptions {
  readonly request: SyncRequest;
  readonly basePath?: string | undefined;
  readonly clientId?: string | undefined;
  readonly onEvents: (events: SyncEvent[]) => void;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly coalesceMs?: number | undefined;
  readonly safetyPollMs?: number | undefined;
  readonly hiddenPollMs?: number | undefined;
  readonly reconnectBaseMs?: number | undefined;
  readonly reconnectMaxMs?: number | undefined;
  readonly isHidden?: (() => boolean) | undefined;
  readonly setTimeout?: typeof globalThis.setTimeout | undefined;
  readonly clearTimeout?: typeof globalThis.clearTimeout | undefined;
  readonly channels?: readonly ClientChannel[] | undefined;
  /**
   * The server refused the credential (401 or 403). The client never degrades to polling
   * on it; it keeps retrying the negotiation with backoff. Defaults to `onError`.
   */
  readonly onUnauthorized?: ((error: SyncUnauthorized) => void) | undefined;
}

export class SyncUnauthorized extends Error {
  override readonly name = "SyncUnauthorized";
  constructor(readonly status: number) {
    super(`sync was refused with HTTP ${status}`);
  }
}

const refused = (response: Response) =>
  response.status === 401 || response.status === 403;

export interface SyncClient {
  start(): void;
  stop(): void;
  readonly cursor: string;
  readonly transport: "sse" | "poll" | undefined;
}

const DEFAULTS = {
  coalesceMs: 250,
  safetyPollMs: 60_000,
  hiddenPollMs: 10_000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
};

interface Handshake {
  readonly capabilities: readonly string[];
  readonly keepAliveMs: number | undefined;
}

function parseHandshake(handshake: string): Handshake {
  try {
    const { capabilities, keepAliveMs } = JSON.parse(handshake) as {
      capabilities?: unknown;
      keepAliveMs?: unknown;
    };
    return {
      capabilities: Array.isArray(capabilities)
        ? capabilities.filter((c): c is string => typeof c === "string")
        : [],
      keepAliveMs:
        typeof keepAliveMs === "number" && keepAliveMs > 0 ? keepAliveMs : undefined,
    };
  } catch {
    return { capabilities: [], keepAliveMs: undefined };
  }
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const basePath = options.basePath ?? "/_parlor";
  const settings = {
    coalesceMs: options.coalesceMs ?? DEFAULTS.coalesceMs,
    safetyPollMs: options.safetyPollMs ?? DEFAULTS.safetyPollMs,
    hiddenPollMs: options.hiddenPollMs ?? DEFAULTS.hiddenPollMs,
    reconnectBaseMs: options.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
    reconnectMaxMs: options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
    clientId: options.clientId,
    onError: options.onError,
  };
  const schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> =
    options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel: (id: ReturnType<typeof setTimeout>) => void =
    options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const isHidden = options.isHidden ?? (() => false);
  const channels = new Map((options.channels ?? []).map((c) => [c.event, c]));
  const guarded = (run: () => void) => {
    try {
      run();
    } catch (error) {
      settings.onError?.(error);
    }
  };

  let cursor: SyncCursor = INITIAL_CURSOR;
  let transport: "sse" | "poll" | undefined;
  let running = false;
  let controller: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: SyncEvent[] = [];
  let reconnectDelay = settings.reconnectBaseMs;

  const accept = (events: readonly SyncEvent[]) => {
    for (const event of events) {
      const at = cursorOf(event);
      if (compareCursors(at, cursor) <= 0) continue;
      cursor = at;
      if (event.source && event.source === settings.clientId) continue;
      pending.push(event);
    }
    if (pending.length > 0 && flushTimer === undefined) {
      flushTimer = schedule(() => {
        flushTimer = undefined;
        const batch = pending;
        pending = [];
        options.onEvents(batch);
      }, settings.coalesceMs);
    }
  };

  const since = () => (cursor === INITIAL_CURSOR ? "" : encodeCursor(cursor));

  const poll = async () => {
    const response = await options.request(
      `${basePath}/sync?since=${encodeURIComponent(since())}`,
    );
    if (refused(response)) throw new SyncUnauthorized(response.status);
    if (!response.ok) throw new Error(`sync poll failed with HTTP ${response.status}`);
    const batch = (await response.json()) as SyncBatch;
    accept(batch.events);
  };

  const schedulePoll = (ms: number) => {
    if (!running) return;
    if (pollTimer !== undefined) cancel(pollTimer);
    pollTimer = schedule(() => {
      pollTimer = undefined;
      let halted = false;
      void poll()
        .catch((error: unknown) => {
          if (error instanceof SyncUnauthorized) {
            halted = true;
            unauthorized(error);
            if (transport === "poll") {
              transport = undefined;
              schedule(() => void connect(), backoff());
            }
            return;
          }
          settings.onError?.(error);
        })
        .finally(() => {
          if (!halted) schedulePoll(nextPollDelay());
        });
    }, ms);
  };

  const nextPollDelay = () => {
    if (transport === "sse") return settings.safetyPollMs;
    const base = negotiatedPollMs;
    return isHidden() ? Math.max(base, settings.hiddenPollMs) : base;
  };
  let negotiatedPollMs = 2000;

  const negotiate = async (): Promise<SyncNegotiation> => {
    const response = await options.request(`${basePath}/sync/token`, { method: "POST" });
    if (refused(response)) throw new SyncUnauthorized(response.status);
    if (!response.ok)
      throw new Error(`sync negotiation failed with HTTP ${response.status}`);
    return (await response.json()) as SyncNegotiation;
  };

  const stream = async (endpoint: string) => {
    const own = new AbortController();
    controller = own;
    let keepAliveMs = LEGACY_KEEP_ALIVE_MS;
    let silent = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const rearm = () => {
      if (watchdog !== undefined) cancel(watchdog);
      watchdog = schedule(() => {
        silent = true;
        own.abort();
      }, streamLivenessMs(keepAliveMs));
    };
    const open = new Set<ClientChannel>();
    rearm();
    try {
      const response = await options.request(
        `${endpoint}?since=${encodeURIComponent(since())}`,
        {
          headers: { accept: "text/event-stream" },
          signal: own.signal,
        },
      );
      if (refused(response)) throw new SyncUnauthorized(response.status);
      if (!response.ok || !response.body) {
        throw new Error(`sync stream failed with HTTP ${response.status}`);
      }
      reconnectDelay = settings.reconnectBaseMs;
      await readSse(
        response.body,
        (frame) => {
          if (frame.event === "message") {
            const batch = JSON.parse(frame.data) as SyncBatch;
            accept(batch.events);
            const parsed = decodeCursor(batch.cursor);
            if (compareCursors(parsed, cursor) > 0) cursor = parsed;
            return;
          }
          if (frame.event === "handshake") {
            const handshake = parseHandshake(frame.data);
            keepAliveMs = handshake.keepAliveMs ?? LEGACY_KEEP_ALIVE_MS;
            rearm();
            for (const event of handshake.capabilities) {
              const channel = channels.get(event);
              if (!channel || open.has(channel)) continue;
              open.add(channel);
              guarded(() => channel.opened());
            }
            return;
          }
          const channel = channels.get(frame.event);
          if (channel && open.has(channel)) guarded(() => channel.receive(frame.data));
        },
        own.signal,
        rearm,
      );
    } catch (error) {
      if (!silent) throw error;
    } finally {
      if (watchdog !== undefined) cancel(watchdog);
      for (const channel of open) guarded(() => channel.closed());
    }
  };

  const unauthorized = (error: SyncUnauthorized) => {
    if (pollTimer !== undefined) cancel(pollTimer);
    pollTimer = undefined;
    (options.onUnauthorized ?? settings.onError)?.(error);
  };

  const backoff = () => {
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, settings.reconnectMaxMs);
    return delay;
  };

  let connecting = false;
  const connect = async () => {
    if (connecting) return;
    connecting = true;
    try {
      await connectLoop();
    } finally {
      connecting = false;
    }
  };

  const connectLoop = async () => {
    for (;;) {
      if (!running) return;
      let endpoint: string | undefined;
      try {
        const negotiation = await negotiate();
        if (!running) return;
        negotiatedPollMs = negotiation.pollIntervalMs;
        if (negotiation.transport === "poll") {
          transport = "poll";
          schedulePoll(0);
          return;
        }
        endpoint = negotiation.endpoint;
      } catch (error) {
        if (!running) return;
        if (error instanceof SyncUnauthorized) {
          transport = undefined;
          unauthorized(error);
        } else {
          settings.onError?.(error);
          if (transport !== "poll") {
            transport = "poll";
            schedulePoll(negotiatedPollMs);
          }
        }
      }
      if (endpoint !== undefined) {
        transport = "sse";
        schedulePoll(settings.safetyPollMs);
        try {
          await stream(endpoint);
        } catch (error) {
          if (!running) return;
          if (error instanceof SyncUnauthorized) unauthorized(error);
          else settings.onError?.(error);
        }
      }
      if (!running) return;
      const delay = backoff();
      await new Promise<void>((resolve) => schedule(() => resolve(), delay));
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    void connect();
  };

  const stop = () => {
    running = false;
    controller?.abort();
    controller = undefined;
    if (pollTimer !== undefined) cancel(pollTimer);
    if (flushTimer !== undefined) cancel(flushTimer);
    pollTimer = flushTimer = undefined;
    pending = [];
  };

  return {
    start,
    stop,
    get cursor() {
      return since();
    },
    get transport() {
      return transport;
    },
  };
}
