import type { ClientChannel } from "../channel.js";
import {
  BUILD_HEADER,
  compareCursors,
  cursorOf,
  decodeCursor,
  encodeCursor,
  INITIAL_CURSOR,
  DEFAULT_SOCKET_PING_MS,
  LEGACY_KEEP_ALIVE_MS,
  SOCKET_PING,
  SOCKET_PONG,
  SYNC_BUILD_PATH,
  type SyncBatch,
  type SyncCursor,
  type SyncEvent,
  type SyncNegotiation,
  streamLivenessMs,
} from "../protocol.js";
import { readSse } from "./sse.js";

export type SyncRequest = (path: string, init?: RequestInit) => Promise<Response>;

export interface SyncSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SyncSocketEvents {
  open(): void;
  message(data: string): void;
  close(): void;
}

/** Opens a socket to `path` (with its query) on the app's origin. */
export type SyncConnect = (path: string, on: SyncSocketEvents) => SyncSocket;

/** `SyncConnect` over the runtime's `WebSocket`, or undefined where there is none. */
export function socketsAt(origin: string): SyncConnect | undefined {
  const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof Socket !== "function") return undefined;
  const base = origin.replace(/^http/, "ws");
  return (path, on) => {
    const socket = new Socket(new URL(path, base).href);
    socket.onopen = () => on.open();
    socket.onmessage = (event) =>
      on.message(typeof event.data === "string" ? event.data : "");
    socket.onclose = () => on.close();
    return {
      send(data) {
        try {
          socket.send(data);
        } catch {
          // A socket that is closing drops it; its close ends the stream.
        }
      },
      close: (code, reason) => socket.close(code, reason),
    };
  };
}

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
  /** Picks each reconnect delay below its backoff ceiling. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  readonly channels?: readonly ClientChannel[] | undefined;
  /**
   * Read each time the next poll is scheduled; the interval is the larger of this and the
   * negotiated one, so a caller can only slow polling down.
   */
  readonly pollEveryMs?: (() => number) | undefined;
  /**
   * Where to read from while the client has no cursor of its own: the encoded cursor of the
   * oldest data the page holds, so the first stream does not replay what that data already
   * shows. Defaults to the start of the retained log.
   */
  readonly startAt?: (() => string) | undefined;
  /**
   * The server could not replay every event since the client's cursor: the client fell
   * more than one batch behind, or behind what the server keeps. Sync continues from
   * `cursor`, where the client's streams stand now; reread whatever predates it. Without
   * it, the client is never reset and a poll pages through the backlog.
   */
  readonly onReset?: ((cursor: string) => void) | undefined;
  /** Bounds a negotiation or a poll, not the SSE stream. Defaults to 10 s. */
  readonly requestTimeoutMs?: number | undefined;
  /**
   * Opens sockets, which a server whose platform holds them while it sleeps prefers: an
   * idle socket costs that server nothing. Without it the client offers server-sent events.
   */
  readonly connect?: SyncConnect | undefined;
  /**
   * What the server negotiated, each time it does; `SyncClient.transport` reads `poll`
   * during the fallback poll of a failed negotiation, this never does.
   */
  readonly onNegotiated?: ((transport: SyncTransport) => void) | undefined;
  /**
   * The negotiated transport's connection came back after a failure: a stream reopened
   * after it dropped, or a poll succeeded after a failed one. A fallback poll on an SSE
   * deployment does not count.
   */
  readonly onResume?: (() => void) | undefined;
  /**
   * The server refused the credential (401 or 403). The client never degrades to polling
   * on it; it keeps retrying the negotiation with backoff, unless this calls `stop`.
   * Defaults to `onError`.
   */
  readonly onUnauthorized?: ((error: SyncUnauthorized) => void) | undefined;
}

export class SyncUnauthorized extends Error {
  override readonly name = "SyncUnauthorized";
  constructor(readonly status: number) {
    super(`sync was refused with HTTP ${status}`);
  }
}

export class SyncRequestTimeout extends Error {
  override readonly name = "SyncRequestTimeout";
  constructor(readonly ms: number) {
    super(`sync request timed out after ${ms} ms`);
  }
}

class StaleRequest extends Error {
  override readonly name = "StaleRequest";
}

const refused = (response: Response) =>
  response.status === 401 || response.status === 403;

export interface SyncClient {
  start(): void;
  stop(): void;
  /**
   * Registers a channel after `start`, for features loaded lazily. It opens at once when
   * the live stream's handshake lists it, else on the next stream. Returns the detach.
   */
  addChannel(channel: ClientChannel): () => void;
  /**
   * Skips the remaining reconnect backoff, for `online` and visibility events. While
   * polling it polls at once; with a stream open or a request in flight it does nothing.
   */
  reconnectNow(): void;
  /**
   * A response's `BUILD_HEADER`, from any request to the app. When the open stream came from
   * another build, a deploy left it on the old one's instance: the stream reopens, once per
   * build seen. The client reads its own sync responses itself.
   */
  observeBuild(build: string | null | undefined): void;
  readonly cursor: string;
  readonly transport: SyncTransport | undefined;
  /**
   * The open stream is a socket the server takes as this client being there, so the client
   * need not say so otherwise, as a computer's heartbeats do.
   */
  readonly presence: boolean;
}

export type SyncTransport = "sse" | "poll" | "ws";

const DEFAULTS = {
  coalesceMs: 250,
  safetyPollMs: 60_000,
  hiddenPollMs: 10_000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
  requestTimeoutMs: 10_000,
};

interface Handshake {
  readonly capabilities: readonly string[];
  readonly keepAliveMs: number | undefined;
  readonly build: string | undefined;
  /** The server takes the open socket as the client being there. */
  readonly presence: boolean;
  readonly pingMs: number | undefined;
}

function parseHandshake(handshake: string): Handshake {
  try {
    const { capabilities, keepAliveMs, build, presence, pingMs } = JSON.parse(
      handshake,
    ) as {
      capabilities?: unknown;
      keepAliveMs?: unknown;
      build?: unknown;
      presence?: unknown;
      pingMs?: unknown;
    };
    return {
      capabilities: Array.isArray(capabilities)
        ? capabilities.filter((c): c is string => typeof c === "string")
        : [],
      keepAliveMs:
        typeof keepAliveMs === "number" && keepAliveMs > 0 ? keepAliveMs : undefined,
      build: typeof build === "string" && build !== "" ? build : undefined,
      presence: presence === true,
      pingMs: typeof pingMs === "number" && pingMs > 0 ? pingMs : undefined,
    };
  } catch {
    return {
      capabilities: [],
      keepAliveMs: undefined,
      build: undefined,
      presence: false,
      pingMs: undefined,
    };
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
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    clientId: options.clientId,
    onError: options.onError,
  };
  const schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> =
    options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel: (id: ReturnType<typeof setTimeout>) => void =
    options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const random = options.random ?? Math.random;
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
  let transport: SyncTransport | undefined;
  let negotiated: SyncTransport | undefined;
  let safety: SyncNegotiation["safety"];
  let interrupted = false;
  let running = false;
  let controller: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: SyncEvent[] = [];
  let reconnectDelay = settings.reconnectBaseMs;
  let endReconnectWait: (() => void) | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  const inflight = new Set<AbortController>();

  const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const mine = epoch;
    const own = new AbortController();
    inflight.add(own);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = schedule(() => {
        own.abort();
        reject(new SyncRequestTimeout(settings.requestTimeoutMs));
      }, settings.requestTimeoutMs);
    });
    try {
      const result = await Promise.race([run(own.signal), expired]);
      if (mine !== epoch) throw new StaleRequest();
      return result;
    } catch (error) {
      if (mine !== epoch) throw new StaleRequest();
      throw error;
    } finally {
      inflight.delete(own);
      if (timer !== undefined) cancel(timer);
    }
  };

  const resumed = () => {
    if (!interrupted) return;
    interrupted = false;
    guarded(() => options.onResume?.());
  };

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

  const held = () => (cursor === INITIAL_CURSOR ? "" : encodeCursor(cursor));
  const since = () =>
    cursor === INITIAL_CURSOR ? (options.startAt?.() ?? "") : encodeCursor(cursor);
  const missedSince = () =>
    `since=${encodeURIComponent(since())}${options.onReset ? "&reset=1" : ""}`;
  /** The server offered a stream that misses nothing, whose client watches the build itself. */
  const offeredBuildWatch = () => transport === "sse" && safety === "build";
  /** Only an open stream misses nothing: until it is greeted, the safety net polls for events. */
  const watchesBuild = () => offeredBuildWatch() && live?.greeted === true;
  /** A greeted socket misses nothing and a deploy closes it, so its safety net asks nothing. */
  const holdsSocket = () => transport === "ws" && live?.greeted === true;

  const take = (batch: SyncBatch) => {
    if (!batch.reset) {
      accept(batch.events);
      return;
    }
    cursor = decodeCursor(batch.cursor);
    guarded(() => options.onReset?.(batch.cursor));
  };

  const poll = async (mine: number) => {
    const batch = await withTimeout(async (signal) => {
      const response = await options.request(`${basePath}/sync?${missedSince()}`, {
        signal,
      });
      observeBuild(response.headers.get(BUILD_HEADER));
      if (refused(response)) throw new SyncUnauthorized(response.status);
      if (!response.ok) throw new Error(`sync poll failed with HTTP ${response.status}`);
      return (await response.json()) as SyncBatch;
    });
    if (mine !== epoch) throw new StaleRequest();
    take(batch);
    if (running && negotiated === "poll") resumed();
  };

  const checkBuild = async (mine: number) => {
    // Read from the body: another origin's page, as in a shell, sees only the headers CORS exposes.
    const build = await withTimeout(async (signal) => {
      const response = await options.request(`${basePath}${SYNC_BUILD_PATH}`, { signal });
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`sync build check failed with HTTP ${response.status}`);
      }
      const answer = (await response.json().catch(() => undefined)) as
        | { readonly build?: unknown }
        | undefined;
      return typeof answer?.build === "string" && answer.build !== ""
        ? answer.build
        : undefined;
    });
    if (mine !== epoch) throw new StaleRequest();
    // No build is not the server that offered to be watched: reopen and negotiate with what answers now.
    if (build) observeBuild(build);
    else live?.move();
  };

  const schedulePoll = (ms: number) => {
    if (!running) return;
    if (pollTimer !== undefined) cancel(pollTimer);
    pollTimer = schedule(() => {
      pollTimer = undefined;
      let halted = false;
      const mine = epoch;
      void (
        holdsSocket() ? Promise.resolve() : watchesBuild() ? checkBuild(mine) : poll(mine)
      )
        .catch((error: unknown) => {
          if (error instanceof StaleRequest || mine !== epoch) {
            halted = true;
            return;
          }
          if (negotiated === "poll") interrupted = true;
          if (error instanceof SyncUnauthorized) {
            halted = true;
            unauthorized(error);
            if (transport === "poll") {
              transport = undefined;
              connectTimer = schedule(() => {
                connectTimer = undefined;
                void connect();
              }, backoff());
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
    if (transport === "sse" || transport === "ws") return settings.safetyPollMs;
    const base = Math.max(negotiatedPollMs, options.pollEveryMs?.() ?? 0);
    return isHidden() ? Math.max(base, settings.hiddenPollMs) : base;
  };
  let negotiatedPollMs = 2000;

  const negotiate = async (): Promise<SyncNegotiation> => {
    return withTimeout(async (signal) => {
      const offer = options.connect ? "?transports=ws" : "";
      const response = await options.request(`${basePath}/sync/token${offer}`, {
        method: "POST",
        signal,
      });
      observeBuild(response.headers.get(BUILD_HEADER));
      if (refused(response)) throw new SyncUnauthorized(response.status);
      if (!response.ok)
        throw new Error(`sync negotiation failed with HTTP ${response.status}`);
      return (await response.json()) as SyncNegotiation;
    });
  };

  interface LiveStream {
    listed: ReadonlySet<string>;
    readonly open: Set<ClientChannel>;
    greeted: boolean;
    build: string | undefined;
    presence: boolean;
    /** Ends the stream to reopen it at once, on the build that answers now. */
    readonly move: () => void;
  }
  let live: LiveStream | undefined;
  /** Builds a stream moved for or away from, so a deploy that keeps both answering moves it once. */
  const settled = new Set<string>();

  const observeBuild = (build: string | null | undefined) => {
    const current = live;
    if (!build || !current?.build || current.build === build || settled.has(build))
      return;
    settled.add(build);
    settled.add(current.build);
    current.move();
  };

  const receive = (
    current: LiveStream,
    frame: { readonly event: string; readonly data: string },
    greeted: (handshake: Handshake) => void,
  ) => {
    if (frame.event === "message") {
      const batch = JSON.parse(frame.data) as SyncBatch;
      take(batch);
      const parsed = decodeCursor(batch.cursor);
      if (compareCursors(parsed, cursor) > 0) cursor = parsed;
      return;
    }
    if (frame.event === "handshake") {
      const handshake = parseHandshake(frame.data);
      current.greeted = true;
      current.presence = handshake.presence;
      current.build = handshake.build ?? current.build;
      greeted(handshake);
      current.listed = new Set(handshake.capabilities);
      for (const event of handshake.capabilities) {
        const channel = channels.get(event);
        if (!channel || current.open.has(channel)) continue;
        current.open.add(channel);
        guarded(() => channel.opened());
      }
      return;
    }
    const channel = channels.get(frame.event);
    if (channel && current.open.has(channel)) guarded(() => channel.receive(frame.data));
  };

  /** A socket's stream: it ends when the socket closes or stops answering its pings. */
  const socket = (endpoint: string, ticket: string): Promise<"ended" | "moved"> =>
    new Promise((resolve, reject) => {
      const own = new AbortController();
      controller = own;
      let pingMs = DEFAULT_SOCKET_PING_MS;
      let opened = false;
      let finished = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let pinger: ReturnType<typeof setTimeout> | undefined;
      const current: LiveStream = {
        listed: new Set(),
        open: new Set(),
        greeted: false,
        build: undefined,
        presence: false,
        move: () => finish("moved"),
      };
      live = current;
      const finish = (how: "ended" | "moved", failure?: Error) => {
        if (finished) return;
        finished = true;
        if (watchdog !== undefined) cancel(watchdog);
        if (pinger !== undefined) cancel(pinger);
        connection.close(1000, "The client left.");
        if (live === current) live = undefined;
        for (const channel of current.open) guarded(() => channel.closed());
        if (failure) reject(failure);
        else resolve(how);
      };
      const rearm = () => {
        if (watchdog !== undefined) cancel(watchdog);
        watchdog = schedule(() => finish("ended"), pingMs * 2 + 5000);
      };
      const ping = () => {
        pinger = schedule(() => {
          connection.send(SOCKET_PING);
          ping();
        }, pingMs);
      };
      own.signal.addEventListener("abort", () => finish("ended"), { once: true });
      const query = `${missedSince()}&ticket=${encodeURIComponent(ticket)}`;
      const connection = options.connect!(`${endpoint}?${query}`, {
        open() {
          opened = true;
          reconnectDelay = settings.reconnectBaseMs;
          resumed();
          rearm();
          ping();
        },
        message(data) {
          rearm();
          if (data === SOCKET_PONG) return;
          let frame: { event?: unknown; data?: unknown };
          try {
            frame = JSON.parse(data) as typeof frame;
          } catch {
            return;
          }
          if (typeof frame.event !== "string" || typeof frame.data !== "string") return;
          receive(current, { event: frame.event, data: frame.data }, (handshake) => {
            pingMs = handshake.pingMs ?? DEFAULT_SOCKET_PING_MS;
            if (pinger !== undefined) cancel(pinger);
            ping();
            rearm();
          });
        },
        close() {
          finish(
            "ended",
            opened ? undefined : new Error("The sync socket did not open."),
          );
        },
      });
      rearm();
    });

  /** Resolves `"moved"` when the stream ended to follow a deploy, which reconnects at once. */
  const stream = async (endpoint: string): Promise<"ended" | "moved"> => {
    const own = new AbortController();
    controller = own;
    let keepAliveMs = LEGACY_KEEP_ALIVE_MS;
    let silent = false;
    let moved = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const rearm = () => {
      if (watchdog !== undefined) cancel(watchdog);
      watchdog = schedule(() => {
        silent = true;
        own.abort();
      }, streamLivenessMs(keepAliveMs));
    };
    const open = new Set<ClientChannel>();
    const current: LiveStream = {
      listed: new Set(),
      open,
      greeted: false,
      build: undefined,
      presence: false,
      move: () => {
        moved = true;
        own.abort();
      },
    };
    live = current;
    rearm();
    try {
      const watching = offeredBuildWatch() ? "&safety=build" : "";
      const response = await options.request(`${endpoint}?${missedSince()}${watching}`, {
        headers: { accept: "text/event-stream" },
        signal: own.signal,
      });
      if (refused(response)) throw new SyncUnauthorized(response.status);
      if (!response.ok || !response.body) {
        throw new Error(`sync stream failed with HTTP ${response.status}`);
      }
      current.build = response.headers.get(BUILD_HEADER) ?? undefined;
      reconnectDelay = settings.reconnectBaseMs;
      resumed();
      await readSse(
        response.body,
        (frame) =>
          receive(current, frame, (handshake) => {
            keepAliveMs = handshake.keepAliveMs ?? LEGACY_KEEP_ALIVE_MS;
            rearm();
          }),
        own.signal,
        rearm,
      );
    } catch (error) {
      if (!silent && !moved) throw error;
    } finally {
      if (watchdog !== undefined) cancel(watchdog);
      if (live === current) live = undefined;
      for (const channel of open) guarded(() => channel.closed());
    }
    return moved ? "moved" : "ended";
  };

  const unauthorized = (error: SyncUnauthorized) => {
    if (pollTimer !== undefined) cancel(pollTimer);
    pollTimer = undefined;
    (options.onUnauthorized ?? settings.onError)?.(error);
  };

  // Full jitter, so clients that lost one server together do not return in lockstep.
  const backoff = () => {
    const ceiling = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, settings.reconnectMaxMs);
    return Math.round(ceiling * random());
  };

  let connecting = false;
  const connect = async () => {
    if (connecting) return;
    connecting = true;
    const mine = epoch;
    try {
      await connectLoop(mine);
    } finally {
      if (mine === epoch) connecting = false;
    }
  };

  const connectLoop = async (mine: number) => {
    const active = () => running && mine === epoch;
    for (;;) {
      if (!active()) return;
      let endpoint: string | undefined;
      let ticket: string | undefined;
      try {
        const negotiation = await negotiate();
        if (!active()) return;
        negotiatedPollMs = negotiation.pollIntervalMs;
        negotiated = negotiation.transport;
        safety = negotiation.safety === "build" ? "build" : undefined;
        guarded(() => options.onNegotiated?.(negotiation.transport));
        if (negotiation.transport === "poll") {
          transport = "poll";
          schedulePoll(0);
          return;
        }
        endpoint = negotiation.endpoint;
        ticket =
          negotiation.transport === "ws" && options.connect
            ? negotiation.ticket
            : undefined;
      } catch (error) {
        if (!active()) return;
        interrupted = true;
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
        transport = ticket ? "ws" : "sse";
        schedulePoll(settings.safetyPollMs);
        let ended: "ended" | "moved" = "ended";
        try {
          ended = await (ticket ? socket(endpoint, ticket) : stream(endpoint));
        } catch (error) {
          if (!active()) return;
          if (error instanceof SyncUnauthorized) unauthorized(error);
          else settings.onError?.(error);
        }
        interrupted = true;
        if (ended === "moved" && active()) continue;
      }
      if (!active()) return;
      const delay = backoff();
      await new Promise<void>((resolve) => {
        const timer = schedule(() => {
          endReconnectWait = undefined;
          resolve();
        }, delay);
        endReconnectWait = () => {
          cancel(timer);
          endReconnectWait = undefined;
          resolve();
        };
      });
    }
  };

  const detachChannel = (channel: ClientChannel) => {
    if (channels.get(channel.event) !== channel) return;
    channels.delete(channel.event);
    if (live?.open.delete(channel)) guarded(() => channel.closed());
  };

  const start = () => {
    if (running) return;
    running = true;
    void connect();
  };

  const reconnectNow = () => {
    if (!running) return;
    if (endReconnectWait) {
      reconnectDelay = settings.reconnectBaseMs;
      endReconnectWait();
    } else if (connectTimer !== undefined) {
      cancel(connectTimer);
      connectTimer = undefined;
      reconnectDelay = settings.reconnectBaseMs;
      void connect();
    }
    if (transport === "poll" && pollTimer !== undefined) schedulePoll(0);
  };

  const stop = () => {
    running = false;
    epoch += 1;
    for (const request of inflight) request.abort();
    inflight.clear();
    controller?.abort();
    controller = undefined;
    connecting = false;
    endReconnectWait?.();
    if (pollTimer !== undefined) cancel(pollTimer);
    if (flushTimer !== undefined) cancel(flushTimer);
    if (connectTimer !== undefined) cancel(connectTimer);
    pollTimer = flushTimer = connectTimer = undefined;
    pending = [];
  };

  return {
    start,
    stop,
    observeBuild,
    addChannel(channel) {
      const replaced = channels.get(channel.event);
      if (replaced === channel) return () => detachChannel(channel);
      if (replaced) detachChannel(replaced);
      channels.set(channel.event, channel);
      if (live?.listed.has(channel.event)) {
        live.open.add(channel);
        guarded(() => channel.opened());
      }
      return () => detachChannel(channel);
    },
    reconnectNow,
    get cursor() {
      return held();
    },
    get transport() {
      return transport;
    },
    get presence() {
      return running && live?.greeted === true && live.presence;
    },
  };
}
