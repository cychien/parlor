import type { Tag } from "@parlor/core";
import { tagsOverlap } from "@parlor/core";
import {
  compareCursors,
  cursorOf,
  decodeCursor,
  encodeCursor,
  INITIAL_CURSOR,
  type SyncCursor,
  type SyncEvent,
} from "@parlor/sync";
import type { QueryClient } from "@tanstack/react-query";

import type { ActionEnvelope } from "../action-client.js";
import { ACTION_QUERY_PREFIX } from "../query-keys.js";

interface Read {
  readonly tags: readonly Tag[];
  /** Every event up to it is in the data; undefined when the server did not say. */
  readonly cursor: SyncCursor | undefined;
}

interface Fetch {
  /** Its answer reflects at least this: the newest cursor seen before it was sent. */
  readonly floor: SyncCursor;
  readonly arrived: SyncEvent[];
  /** The newest reset while it was in flight: events up to it were never delivered. */
  reset: SyncCursor | undefined;
}

/** One recorded read: its query hash, read tags and the encoded cursor its data reflects. */
export type ReadEntry = readonly [string, readonly Tag[], string?];

const encoded = (cursor: SyncCursor) =>
  compareCursors(cursor, INITIAL_CURSOR) === 0 ? "" : encodeCursor(cursor);

const later = (a: SyncCursor, b: SyncCursor) => (compareCursors(a, b) > 0 ? a : b);

const newer = (event: SyncEvent, cursor: SyncCursor | undefined) =>
  cursor === undefined || compareCursors(cursorOf(event), cursor) > 0;

const overlaps = (reads: readonly Tag[], event: SyncEvent) =>
  reads.some((read) => event.tags.some((write) => tagsOverlap(read, write)));

const predates = (read: Read, reset: SyncCursor | undefined) =>
  reset !== undefined &&
  read.tags.length > 0 &&
  (read.cursor === undefined || compareCursors(read.cursor, reset) < 0);

/**
 * What each action query read and how far into the sync log its data reaches, so an event
 * invalidates only the queries whose data it is newer than.
 */
export class ReadTagRegistry {
  readonly #reads = new Map<string, Read>();
  readonly #fetches = new Set<Fetch>();
  readonly #outdated = new Set<string>();
  #seen: SyncCursor = INITIAL_CURSOR;

  attach(queryClient: QueryClient): () => void {
    return queryClient.getQueryCache().subscribe((event) => {
      const hash = event.query.queryHash;
      if (event.type === "removed") {
        this.#reads.delete(hash);
        this.#outdated.delete(hash);
      } else if (
        event.type === "updated" &&
        event.action.type === "success" &&
        this.#outdated.delete(hash)
      ) {
        void queryClient.invalidateQueries({
          queryKey: event.query.queryKey,
          exact: true,
        });
      }
    });
  }

  /**
   * Runs one fetch of a query and records what its answer read. An event that arrived while
   * it was in flight and is newer than the answer invalidates the data once it lands.
   */
  async read<T>(queryHash: string, fetch: () => Promise<ActionEnvelope<T>>): Promise<T> {
    const pending: Fetch = { floor: this.#seen, arrived: [], reset: undefined };
    this.#fetches.add(pending);
    try {
      const { data, tags, cursor } = await fetch();
      const read = this.record(queryHash, tags, cursor);
      if (
        predates(read, pending.reset) ||
        pending.arrived.some(
          (event) => newer(event, read.cursor) && overlaps(tags, event),
        )
      )
        this.#outdated.add(queryHash);
      return data;
    } finally {
      this.#fetches.delete(pending);
    }
  }

  record(queryHash: string, tags: readonly Tag[], cursor?: string): Read {
    const read: Read = {
      tags,
      cursor: cursor === undefined ? undefined : decodeCursor(cursor),
    };
    this.#reads.set(queryHash, read);
    if (read.cursor) this.#seen = later(read.cursor, this.#seen);
    return read;
  }

  tagsFor(queryHash: string): readonly Tag[] | undefined {
    return this.#reads.get(queryHash)?.tags;
  }

  /** Every query's reads, to carry a server-rendered cache to the browser. */
  entries(): ReadEntry[] {
    return [...this.#reads].map(([hash, { tags, cursor }]) =>
      cursor === undefined ? [hash, tags] : [hash, tags, encodeCursor(cursor)],
    );
  }

  /** Sync events that arrived; fetches in flight keep them to check their answers against. */
  observe(events: readonly SyncEvent[]): void {
    for (const event of events) this.#seen = later(cursorOf(event), this.#seen);
    for (const fetch of this.#fetches) fetch.arrived.push(...events);
  }

  affected(events: readonly SyncEvent[]): Set<string> {
    const hashes = new Set<string>();
    for (const [hash, { tags, cursor }] of this.#reads) {
      if (events.some((event) => newer(event, cursor) && overlaps(tags, event))) {
        hashes.add(hash);
      }
    }
    return hashes;
  }

  /**
   * Sync was reset to `cursor` without the events before it: every query whose data may
   * predate it, and fetches in flight, whose answers are checked when they land.
   */
  reset(cursor: SyncCursor): Set<string> {
    this.#seen = later(cursor, this.#seen);
    for (const fetch of this.#fetches) fetch.reset = cursor;
    const hashes = new Set<string>();
    for (const [hash, read] of this.#reads) if (predates(read, cursor)) hashes.add(hash);
    return hashes;
  }

  /** The newest cursor any answer or event has shown, encoded; every later read reflects it. */
  latest(): string {
    return encoded(this.#seen);
  }

  /**
   * The oldest point of the sync log that data held or being fetched may predate, and no
   * later than `notAfter`, encoded. A stream that starts there misses nothing and replays
   * no event that data already shows.
   */
  position(notAfter?: string): string {
    let oldest = notAfter === undefined ? undefined : decodeCursor(notAfter);
    const consider = (cursor: SyncCursor) => {
      if (oldest === undefined || compareCursors(cursor, oldest) < 0) oldest = cursor;
    };
    for (const { tags, cursor } of this.#reads.values()) {
      if (tags.length > 0) consider(cursor ?? INITIAL_CURSOR);
    }
    for (const { floor } of this.#fetches) consider(floor);
    return encoded(oldest ?? this.#seen);
  }
}

const registries = new WeakMap<QueryClient, ReadTagRegistry>();

/** The one registry of `queryClient`, shared by hooks, loaders and sync; it lives as long as the client. */
export function readTagsOf(queryClient: QueryClient): ReadTagRegistry {
  let registry = registries.get(queryClient);
  if (!registry) {
    registry = new ReadTagRegistry();
    registry.attach(queryClient);
    registries.set(queryClient, registry);
  }
  return registry;
}

/** Invalidates every query whose data may predate the cursor sync was reset to. */
export function invalidateForReset(
  queryClient: QueryClient,
  registry: ReadTagRegistry,
  cursor: string,
): Promise<void> {
  return invalidateHashes(queryClient, registry.reset(decodeCursor(cursor)));
}

export function invalidateForEvents(
  queryClient: QueryClient,
  registry: ReadTagRegistry,
  events: readonly SyncEvent[],
): Promise<void> {
  registry.observe(events);
  return invalidateHashes(queryClient, registry.affected(events));
}

function invalidateHashes(queryClient: QueryClient, hashes: Set<string>): Promise<void> {
  if (hashes.size === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    queryKey: ACTION_QUERY_PREFIX,
    predicate: (query) => hashes.has(query.queryHash),
  });
}
