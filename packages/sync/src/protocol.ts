import type { Tag } from "@parlor/core";

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_CHANNEL = "parlor_sync";

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
}

export interface SyncNegotiation {
  readonly protocol: typeof SYNC_PROTOCOL_VERSION;
  readonly transport: "sse" | "poll";
  readonly endpoint: string;
  readonly pollIntervalMs: number;
}
