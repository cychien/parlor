import type { DataProvider } from "@parlor/core";
import { createEventStream, getQuery, type H3, type H3Event } from "h3";

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
  SYNC_PROTOCOL_VERSION,
} from "../protocol.js";
import type { SyncHub } from "./hub.js";
import { readSyncEvents, type SyncDatabase } from "./store.js";

export type SyncTransport = "sse" | "poll";

export interface SyncRouteOptions {
  readonly basePath: string;
  readonly data: DataProvider;
  readonly hub: SyncHub;
  readonly scope: (request: Request) => string | Promise<string>;
  readonly transport?: SyncTransport | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly keepAliveMs?: number | undefined;
  readonly channels?: readonly ServerChannel[] | undefined;
  readonly clientId?: ((request: Request) => string | undefined) | undefined;
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

export function registerSyncRoutes(app: H3, options: SyncRouteOptions): void {
  const { basePath, data, hub, scope } = options;
  const transport: SyncTransport =
    options.transport ?? transportFromEnv() ?? (hub.canPush ? "sse" : "poll");
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const db = () => data.read() as SyncDatabase;
  const channels = options.channels ?? [];
  const capabilities = channels.map((channel) => channel.event);

  app.post(`${basePath}/sync/token`, (): SyncNegotiation => ({
    protocol: SYNC_PROTOCOL_VERSION,
    transport,
    endpoint: `${basePath}/sync/stream`,
    pollIntervalMs,
  }));

  app.get(`${basePath}/sync`, async (event: H3Event) => {
    const since = String(getQuery(event).since ?? "");
    const events = await readSyncEvents(
      db(),
      await scope(event.req),
      decodeCursor(since),
    );
    event.res.headers.set("cache-control", "no-store");
    return batch(events, since);
  });

  app.get(`${basePath}/sync/stream`, async (event: H3Event) => {
    const currentScope = await scope(event.req);
    const sinceParam = String(getQuery(event).since ?? "");
    await hub.start();
    const stream = createEventStream(event);
    const send = (payload: SyncBatch) => void stream.push(JSON.stringify(payload));
    const sendLive = (syncEvent: SyncEvent) =>
      send({ events: [syncEvent], cursor: encodeCursor(cursorOf(syncEvent)) });

    let arrivedDuringCatchUp: SyncEvent[] | undefined = [];
    const unsubscribe = hub.subscribe(
      currentScope,
      (syncEvent) => {
        if (arrivedDuringCatchUp) arrivedDuringCatchUp.push(syncEvent);
        else sendLive(syncEvent);
      },
      () => void stream.close(),
    );
    const keepAlive = setInterval(
      () => void stream.pushComment("keep-alive"),
      keepAliveMs,
    );
    const disconnects: (() => void)[] = [];
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      clearInterval(keepAlive);
      unsubscribe();
      for (const disconnect of disconnects) disconnect();
    };
    stream.onClosed(detach);

    void stream.push({
      event: "handshake",
      data: JSON.stringify({
        protocol: SYNC_PROTOCOL_VERSION,
        capabilities,
        keepAliveMs,
      }),
    });
    const clientId = options.clientId?.(event.req);
    for (const channel of channels) {
      disconnects.push(
        channel.connect({
          clientId,
          scope: currentScope,
          send: (frame) => {
            if (!detached) void stream.push({ event: channel.event, data: frame });
          },
        }),
      );
    }
    const since = decodeCursor(sinceParam);
    const missed = await readSyncEvents(db(), currentScope, since).catch(
      (error: unknown) => {
        detach();
        throw error;
      },
    );
    if (missed.length > 0) send(batch(missed, sinceParam));
    const last = missed.at(-1);
    const caughtUpTo = last ? cursorOf(last) : since;
    const pending = arrivedDuringCatchUp.filter(
      (syncEvent) => compareCursors(cursorOf(syncEvent), caughtUpTo) > 0,
    );
    arrivedDuringCatchUp = undefined;
    for (const syncEvent of pending) sendLive(syncEvent);
    const body = await stream.send();
    if (event.req.headers.get("connection") === "keep-alive") {
      event.res.headers.set("connection", "close");
    }
    return body;
  });
}
