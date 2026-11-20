import type { DataProvider, Principal } from "@parlor/core";
import { getQuery, type H3, type H3Event } from "h3";

import type { ServerChannel } from "../channel.js";
import {
  compareCursors,
  cursorOf,
  decodeCursor,
  DEFAULT_KEEP_ALIVE_MS,
  encodeCursor,
  type SyncBatch,
  type SyncEvent,
  type SyncNegotiation,
  DEFAULT_SOCKET_PING_MS,
  SYNC_BUILD_PATH,
  SYNC_PROTOCOL_VERSION,
  SYNC_SOCKET_PATH,
  BUILD_HEADER,
  DEFAULT_MAX_STREAM_MS,
} from "../protocol.js";
import { createEventStream, DEFAULT_MAX_QUEUED_BYTES } from "./event-stream.js";
import type { SyncHub } from "./hub.js";
import {
  createSyncSockets,
  type RestoredSocket,
  type StreamSink,
  type StreamSpec,
  type SyncSockets,
} from "./sockets.js";
import {
  MAX_BATCH,
  readSyncBacklog,
  readSyncEvents,
  type SyncDatabase,
} from "./store.js";

export type SyncTransport = "sse" | "poll";

export interface SyncRouteOptions {
  readonly basePath: string;
  readonly data: DataProvider;
  readonly hub: SyncHub;
  readonly scope: (request: Request) => string | Promise<string>;
  /**
   * The caller's own stream inside its scope, for events only its user should hear (an
   * action with `notifies: "user"`); read and pushed alongside the scope's.
   */
  readonly audience?: ((request: Request) => string | Promise<string>) | undefined;
  /**
   * The caller's user across every scope, for events about the person rather than the scope
   * (an action with `notifies: "account"`); read and pushed alongside the others when set.
   */
  readonly account?:
    | ((request: Request) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly transport?: SyncTransport | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly keepAliveMs?: number | undefined;
  /**
   * How far a stream's reader may fall behind before the server drops its connection; the
   * client then reconnects and catches up from its cursor. Defaults to 1 MiB.
   */
  readonly maxQueuedBytes?: number | undefined;
  readonly channels?: readonly ServerChannel[] | undefined;
  readonly clientId?: ((request: Request) => string | undefined) | undefined;
  /** This server's build, sent as `BUILD_HEADER` and in the stream's handshake; read per request. */
  readonly build?: (() => string | undefined) | undefined;
  /**
   * How long a stream lives, give or take a tenth, before the server ends it and the client
   * reopens it, so an instance an old deploy left behind drains. Defaults to 15 minutes. A
   * stream whose client watches the build itself (`SyncNegotiation.safety`) is never ended.
   */
  readonly maxStreamMs?: number | undefined;
  /**
   * Who holds a stream and until when. A stream closes when `revoked` aborts, and a
   * stream without `channels` carries sync events only. Refusing a caller happens before
   * these routes run.
   */
  readonly authority?: ((request: Request) => Promise<StreamAuthority>) | undefined;
  /** Aborts when the credential behind `principal` is revoked, for a socket rewired after a sleep. */
  readonly revokedOf?: ((principal: Principal) => AbortSignal | undefined) | undefined;
  /** What `SyncSockets.remember` kept with a client's sockets, handed back once they are rewired. */
  readonly restored?: ((held: RestoredSocket) => void) | undefined;
  /** How often a socket's client pings, which the platform answers without waking the server. */
  readonly pingMs?: number | undefined;
}

export interface SyncRoutes {
  readonly sockets: SyncSockets;
}

export interface StreamAuthority {
  readonly principal: Principal;
  readonly revoked?: AbortSignal | undefined;
  /** Which channels the stream carries: all, none, or those the predicate admits. */
  readonly channels: boolean | ((channel: ServerChannel) => boolean);
}

export const DEFAULT_POLL_INTERVAL_MS = 2000;

export function transportFromEnv(
  value: string | undefined = process.env.PARLOR_SYNC_TRANSPORT,
): SyncTransport | undefined {
  return value === "sse" || value === "poll" ? value : undefined;
}

function batch(events: SyncEvent[], since: string): SyncBatch {
  const last = events.at(-1);
  return { events, cursor: last ? encodeCursor(cursorOf(last)) : since };
}

const CATCH_UP_FRAME_CHARS = 64 * 1024;

function catchUpFrames(missed: SyncBatch): SyncBatch[] {
  if (missed.reset) return [missed];
  const frames: SyncBatch[] = [];
  let events: SyncEvent[] = [];
  let size = 0;
  for (const event of missed.events) {
    const eventSize = JSON.stringify(event).length;
    if (events.length > 0 && size + eventSize > CATCH_UP_FRAME_CHARS) {
      frames.push(batch(events, missed.cursor));
      events = [];
      size = 0;
    }
    events.push(event);
    size += eventSize;
  }
  if (events.length > 0) frames.push(batch(events, missed.cursor));
  return frames;
}

export interface MissedQuery {
  readonly since: string;
  readonly reset: boolean;
  /** The client asks `SYNC_BUILD_PATH` itself, so the stream need not end to move it. */
  readonly watchesBuild: boolean;
}

function missedQuery(event: H3Event): MissedQuery {
  const query = getQuery(event);
  return {
    since: String(query.since ?? ""),
    reset: query.reset === "1",
    watchesBuild: query.safety === "build",
  };
}

async function missedSince(
  db: SyncDatabase,
  streams: readonly string[],
  { since, reset }: Pick<MissedQuery, "since" | "reset">,
): Promise<SyncBatch> {
  if (!reset) {
    return batch(await readSyncEvents(db, streams, decodeCursor(since)), since);
  }
  const backlog = await readSyncBacklog(db, streams, decodeCursor(since));
  if (backlog.resetTo) {
    return { events: [], cursor: encodeCursor(backlog.resetTo), reset: true };
  }
  return batch(backlog.events, since);
}

export function registerSyncRoutes(app: H3, options: SyncRouteOptions): SyncRoutes {
  const { basePath, data, hub, scope } = options;
  const streamsOf = async (request: Request): Promise<readonly string[]> => {
    const own = await scope(request);
    const audience = await options.audience?.(request);
    const account = await options.account?.(request);
    return [...new Set([own, audience, account].filter((name) => name !== undefined))];
  };
  const transport: SyncTransport =
    options.transport ?? transportFromEnv() ?? (hub.canPush ? "sse" : "poll");
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const db = () => data.read() as SyncDatabase;
  const channels = options.channels ?? [];
  const maxStreamMs = options.maxStreamMs ?? DEFAULT_MAX_STREAM_MS;
  const stamp = (event: H3Event) => {
    const build = options.build?.();
    if (build !== undefined) event.res.headers.set(BUILD_HEADER, build);
  };
  const safety = () =>
    transport === "sse" && hub.lossless && options.build?.() !== undefined
      ? ("build" as const)
      : undefined;

  const carriedBy = (authority: StreamAuthority | undefined) => {
    const admitted = authority?.channels ?? true;
    return channels.filter((channel) =>
      typeof admitted === "function" ? admitted(channel) : admitted,
    );
  };

  /**
   * Joins a stream to the hub and to its channels, until `sink` closes. Opening one also
   * greets it and sends what it missed since its cursor, before anything live.
   */
  const attach = async (
    sink: StreamSink,
    spec: StreamSpec,
    opening?: { readonly query: MissedQuery; readonly handshake: object },
  ): Promise<void> => {
    const { streams } = spec;
    const send = (payload: SyncBatch) => sink.push({ data: JSON.stringify(payload) });
    const sendLive = (syncEvent: SyncEvent) =>
      send({ events: [syncEvent], cursor: encodeCursor(cursorOf(syncEvent)) });

    let arrivedDuringCatchUp: SyncEvent[] | undefined = opening ? [] : undefined;
    let droppedDuringCatchUp = false;
    const unsubscribes = streams.map((name) =>
      hub.subscribe(
        name,
        (syncEvent) => {
          if (!arrivedDuringCatchUp) sendLive(syncEvent);
          else if (arrivedDuringCatchUp.length < MAX_BATCH)
            arrivedDuringCatchUp.push(syncEvent);
          else {
            arrivedDuringCatchUp = [];
            droppedDuringCatchUp = true;
          }
        },
        () => sink.close(),
      ),
    );
    const disconnects: (() => void)[] = [];
    const ended = new AbortController();
    const { revoked } = spec;
    const closeRevoked = () => sink.close();
    const detach = () => {
      if (ended.signal.aborted) return;
      ended.abort();
      revoked?.removeEventListener("abort", closeRevoked);
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const disconnect of disconnects) disconnect();
    };
    sink.onClosed(detach);
    if (revoked?.aborted) closeRevoked();
    else revoked?.addEventListener("abort", closeRevoked, { once: true });

    if (opening) {
      sink.push({
        event: "handshake",
        data: JSON.stringify({
          protocol: SYNC_PROTOCOL_VERSION,
          capabilities: spec.channels.map((channel) => channel.event),
          ...opening.handshake,
        }),
      });
    }
    for (const channel of spec.channels) {
      disconnects.push(
        channel.connect({
          clientId: spec.clientId,
          scope: streams[0]!,
          ...(spec.principal ? { principal: spec.principal } : {}),
          closed: ended.signal,
          ...(spec.watched ? { watched: true } : {}),
          send: (frame) => sink.push({ event: channel.event, data: frame }),
        }),
      );
    }
    if (!opening) return;

    const { query } = opening;
    const catchUp = async (first: SyncBatch) => {
      let missed = first;
      for (;;) {
        for (const frame of catchUpFrames(missed)) {
          await sink.drained();
          if (ended.signal.aborted) return;
          send(frame);
        }
        const truncated = !missed.reset && missed.events.length >= MAX_BATCH;
        if (!truncated && !droppedDuringCatchUp) break;
        droppedDuringCatchUp = false;
        missed = await missedSince(db(), streams, { ...query, since: missed.cursor });
      }
      const caughtUpTo = decodeCursor(missed.cursor);
      const pending = arrivedDuringCatchUp!
        .filter((syncEvent) => compareCursors(cursorOf(syncEvent), caughtUpTo) > 0)
        .sort((a, b) => compareCursors(cursorOf(a), cursorOf(b)));
      arrivedDuringCatchUp = undefined;
      for (const syncEvent of pending) sendLive(syncEvent);
    };
    const first = await missedSince(db(), streams, query).catch((error: unknown) => {
      detach();
      throw error;
    });
    void catchUp(first).catch((error: unknown) => {
      console.error("[parlor] sync catch-up failed:", error);
      sink.close();
    });
  };

  const sockets = createSyncSockets({
    hub,
    pingMs: options.pingMs ?? DEFAULT_SOCKET_PING_MS,
    held: async (request) => {
      const authority = await options.authority?.(request);
      return {
        streams: [...(await streamsOf(request))],
        audience: await options.audience?.(request),
        clientId: options.clientId?.(request),
        principal: authority?.principal,
        channels: carriedBy(authority).map((channel) => channel.event),
        revoked: authority?.revoked,
      };
    },
    attach: (sink, held, revoked, query) =>
      attach(
        sink,
        {
          streams: held.streams,
          principal: held.principal,
          clientId: held.clientId,
          channels: channels.filter((channel) => held.channels.includes(channel.event)),
          revoked: revoked ?? (held.principal && options.revokedOf?.(held.principal)),
          watched: true,
        },
        query
          ? {
              query: { ...query, watchesBuild: false },
              handshake: {
                presence: true,
                pingMs: options.pingMs ?? DEFAULT_SOCKET_PING_MS,
                ...(options.build?.() === undefined ? {} : { build: options.build() }),
              },
            }
          : undefined,
      ),
    restored: options.restored,
  });

  app.post(`${basePath}/sync/token`, async (event: H3Event): Promise<SyncNegotiation> => {
    stamp(event);
    const offered = String(getQuery(event).transports ?? "").split(",");
    if (offered.includes("ws") && sockets.installed && hub.lossless) {
      return {
        protocol: SYNC_PROTOCOL_VERSION,
        transport: "ws",
        endpoint: `${basePath}${SYNC_SOCKET_PATH}`,
        pollIntervalMs,
        ticket: await sockets.ticket(event.req),
      };
    }
    const advised = safety();
    return {
      protocol: SYNC_PROTOCOL_VERSION,
      transport,
      endpoint: `${basePath}/sync/stream`,
      pollIntervalMs,
      ...(advised ? { safety: advised } : {}),
    };
  });

  app.get(`${basePath}${SYNC_BUILD_PATH}`, (event: H3Event) => {
    stamp(event);
    event.res.headers.set("cache-control", "no-store");
    return { build: options.build?.() ?? null };
  });

  app.get(`${basePath}/sync`, async (event: H3Event) => {
    const missed = await missedSince(
      db(),
      await streamsOf(event.req),
      missedQuery(event),
    );
    event.res.headers.set("cache-control", "no-store");
    stamp(event);
    return missed;
  });

  app.get(`${basePath}/sync/stream`, async (event: H3Event) => {
    const streams = await streamsOf(event.req);
    const build = options.build?.();
    const authority = await options.authority?.(event.req);
    await hub.start();
    const stream = createEventStream(maxQueuedBytes);
    const query = missedQuery(event);
    const keepAlive = setInterval(() => stream.comment("keep-alive"), keepAliveMs);
    const lifetime =
      query.watchesBuild && safety() === "build"
        ? undefined
        : setTimeout(() => stream.close(), maxStreamMs * (0.9 + 0.2 * Math.random()));
    stream.onClosed(() => {
      clearInterval(keepAlive);
      clearTimeout(lifetime);
    });
    try {
      await attach(
        stream,
        {
          streams,
          principal: authority?.principal,
          clientId: options.clientId?.(event.req),
          channels: carriedBy(authority),
          revoked: authority?.revoked,
        },
        { query, handshake: { keepAliveMs, ...(build === undefined ? {} : { build }) } },
      );
    } catch (error) {
      stream.close();
      throw error;
    }

    event.res.headers.set("content-type", "text/event-stream");
    stamp(event);
    event.res.headers.set("cache-control", "no-cache, no-store, no-transform");
    event.res.headers.set("x-accel-buffering", "no");
    if (event.req.headers.get("connection") === "keep-alive") {
      event.res.headers.set("connection", "close");
    }
    return stream.body;
  });

  return { sockets };
}
