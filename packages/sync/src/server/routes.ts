import type { DataProvider } from "@parlor/core";
import { createEventStream, getQuery, type H3, type H3Event } from "h3";

import {
  cursorOf,
  decodeCursor,
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
}

export const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_KEEPALIVE_MS = 25_000;

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
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
  const db = () => data.read() as SyncDatabase;

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
    const since = String(getQuery(event).since ?? "");
    await hub.start();
    const missed = await readSyncEvents(db(), currentScope, decodeCursor(since));
    const stream = createEventStream(event);
    const send = (payload: SyncBatch) => void stream.push(JSON.stringify(payload));

    void stream.push({
      event: "handshake",
      data: JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, capabilities: [] }),
    });
    if (missed.length > 0) send(batch(missed, since));

    const unsubscribe = hub.subscribe(currentScope, (syncEvent) =>
      send({ events: [syncEvent], cursor: encodeCursor(cursorOf(syncEvent)) }),
    );
    const keepAlive = setInterval(
      () => void stream.pushComment("keep-alive"),
      keepAliveMs,
    );
    stream.onClosed(() => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return stream.send();
  });
}
