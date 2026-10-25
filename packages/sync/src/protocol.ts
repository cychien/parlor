import type { Tag } from "@parlor/core";

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_CHANNEL = "parlor_sync";
export const DEFAULT_KEEP_ALIVE_MS = 10_000;
export const LEGACY_KEEP_ALIVE_MS = 25_000;

const STREAM_LIVENESS_MARGIN_MS = 5000;

export function streamLivenessMs(keepAliveMs: number): number {
  return keepAliveMs * 2 + STREAM_LIVENESS_MARGIN_MS;
}

export interface SyncEvent {
  readonly version: number;
  readonly id: string;
  readonly tags: readonly Tag[];
  readonly source?: string | undefined;
}

export interface SyncCursor {
  readonly version: number;
  readonly id: string;
}

export const INITIAL_CURSOR: SyncCursor = { version: 0, id: "" };

export function encodeCursor(cursor: SyncCursor): string {
  return `${cursor.version}.${cursor.id}`;
}

export function decodeCursor(value: unknown): SyncCursor {
  if (typeof value !== "string" || value === "") return INITIAL_CURSOR;
  const separator = value.indexOf(".");
  const version = Number(separator === -1 ? value : value.slice(0, separator));
  if (!Number.isSafeInteger(version) || version < 0) return INITIAL_CURSOR;
  return { version, id: separator === -1 ? "" : value.slice(separator + 1) };
}

export function compareCursors(a: SyncCursor, b: SyncCursor): number {
  if (a.version !== b.version) return a.version - b.version;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function cursorOf(event: SyncEvent): SyncCursor {
  return { version: event.version, id: event.id };
}

export interface SyncBatch {
  readonly events: readonly SyncEvent[];
  readonly cursor: string;
  /**
   * The server cannot replay every event after the cursor the client sent: there are more
   * than one batch of them, or pruning may have removed some. `events` is empty and
   * `cursor` is where the client's streams stand now, so anything derived from events
   * before it may be stale. Sent only to a client that asks with `reset=1`.
   */
  readonly reset?: true | undefined;
}

export interface SyncNegotiation {
  readonly protocol: typeof SYNC_PROTOCOL_VERSION;
  readonly transport: "sse" | "poll";
  readonly endpoint: string;
  readonly pollIntervalMs: number;
}
