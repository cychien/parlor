import type { Tag } from "@parlor/core";
import { tagsOverlap } from "@parlor/core";
import type { SyncEvent } from "@parlor/sync";
import type { QueryClient } from "@tanstack/react-query";

import { ACTION_QUERY_PREFIX } from "../query-keys.js";

export class ReadTagRegistry {
  readonly #tags = new Map<string, readonly Tag[]>();

  attach(queryClient: QueryClient): () => void {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "removed") this.#tags.delete(event.query.queryHash);
    });
  }

  record(queryHash: string, tags: readonly Tag[]): void {
    this.#tags.set(queryHash, tags);
  }

  tagsFor(queryHash: string): readonly Tag[] | undefined {
    return this.#tags.get(queryHash);
  }

  /** Every query's read tags, to carry a server-rendered cache to the browser. */
  entries(): [string, readonly Tag[]][] {
    return [...this.#tags];
  }

  affected(events: readonly SyncEvent[]): Set<string> {
    const hashes = new Set<string>();
    for (const [hash, reads] of this.#tags) {
      if (
        reads.some((read) =>
          events.some((e) => e.tags.some((write) => tagsOverlap(read, write))),
        )
      ) {
        hashes.add(hash);
      }
    }
    return hashes;
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

export function invalidateForEvents(
  queryClient: QueryClient,
  registry: ReadTagRegistry,
  events: readonly SyncEvent[],
): Promise<void> {
  const hashes = registry.affected(events);
  if (hashes.size === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    queryKey: ACTION_QUERY_PREFIX,
    predicate: (query) => hashes.has(query.queryHash),
  });
}
