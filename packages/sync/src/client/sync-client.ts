import type { ClientChannel } from "../channel.js";
import {
  compareCursors,
  cursorOf,
  decodeCursor,
  encodeCursor,
  INITIAL_CURSOR,
  type SyncBatch,
  type SyncCursor,
  type SyncEvent,
  type SyncNegotiation,
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
}

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
    if (!response.ok) throw new Error(`sync poll failed with HTTP ${response.status}`);
    const batch = (await response.json()) as SyncBatch;
    accept(batch.events);
  };

  const schedulePoll = (ms: number) => {
    if (!running) return;
    if (pollTimer !== undefined) cancel(pollTimer);
    pollTimer = schedule(() => {
      pollTimer = undefined;
      void poll()
        .catch(settings.onError ?? (() => {}))
        .finally(() => schedulePoll(nextPollDelay()));
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
    if (!response.ok)
      throw new Error(`sync negotiation failed with HTTP ${response.status}`);
    return (await response.json()) as SyncNegotiation;
  };

  const stream = async (endpoint: string) => {
    controller = new AbortController();
    const response = await options.request(
      `${endpoint}?since=${encodeURIComponent(since())}`,
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`sync stream failed with HTTP ${response.status}`);
    }
    reconnectDelay = settings.reconnectBaseMs;
    await readSse(
      response.body,
      (frame) => {
        if (frame.event !== "message") return;
        const batch = JSON.parse(frame.data) as SyncBatch;
        accept(batch.events);
        const parsed = decodeCursor(batch.cursor);
        if (compareCursors(parsed, cursor) > 0) cursor = parsed;
      },
      controller.signal,
    );
  };

  const runSse = async (endpoint: string) => {
    for (;;) {
      if (!running) return;
      try {
        await stream(endpoint);
      } catch (error) {
        if (!running) return;
        settings.onError?.(error);
      }
      if (!running) return;
      await new Promise<void>((resolve) => schedule(() => resolve(), reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, settings.reconnectMaxMs);
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    void negotiate()
      .then((negotiation) => {
        if (!running) return;
        transport = negotiation.transport;
        negotiatedPollMs = negotiation.pollIntervalMs;
        if (transport === "sse") void runSse(negotiation.endpoint);
        schedulePoll(transport === "sse" ? settings.safetyPollMs : 0);
      })
      .catch((error) => {
        settings.onError?.(error);
        transport = "poll";
        schedulePoll(negotiatedPollMs);
      });
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
