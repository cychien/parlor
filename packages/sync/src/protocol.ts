import type { Tag } from "@parlor/core";

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_CHANNEL = "parlor_sync";
export const DEFAULT_KEEP_ALIVE_MS = 10_000;
export const LEGACY_KEEP_ALIVE_MS = 25_000;
/**
 * The server build that answered, on every sync response and in the stream's handshake. A
 * client whose stream came from another build than its latest response reopens the stream,
 * so a deploy does not leave it on the old build's instance.
 */
export const BUILD_HEADER = "x-parlor-build";
/** How long a stream lives before the server ends it and the client reopens it. */
export const DEFAULT_MAX_STREAM_MS = 15 * 60_000;

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
  /** `ws` only for a client that offered it (`?transports=ws`) and a server whose platform holds sockets. */
  readonly transport: "sse" | "poll" | "ws";
  readonly endpoint: string;
  readonly pollIntervalMs: number;
  /** With `ws`: what the socket's URL carries in place of a credential, which a socket cannot send. */
  readonly ticket?: string | undefined;
  /**
   * `build`: no event can miss the stream, so while it is open the client polls for none.
   * It only asks `SYNC_BUILD_PATH` which build answers now, to leave a stream that a deploy
   * left on the old one, and says so when it opens the stream (`safety=build`), which then
   * lives until it drops. Absent, the client polls for missed events as its safety net.
   */
  readonly safety?: "build" | undefined;
}

/** Answers the server's build to anyone, touching neither the database nor a session. */
export const SYNC_BUILD_PATH = "/sync/build";

/** Where a client opens a socket the server's platform holds while the server sleeps. */
export const SYNC_SOCKET_PATH = "/sync/socket";
/** What a client sends on its socket to learn it still stands; the platform answers `SOCKET_PONG` on its own. */
export const SOCKET_PING = "ping";
export const SOCKET_PONG = "pong";
export const DEFAULT_SOCKET_PING_MS = 30_000;

/** One frame on a socket: what a server-sent event of that name carries. */
export interface SocketFrame {
  readonly event: string;
  readonly data: string;
}
