import {
  type ActionInput,
  type ActionOutput,
  MAX_REFRESHED_READS,
  type ReadRequest,
  tagsOverlap,
} from "@parlor/core";
import type { Query, QueryClient } from "@tanstack/react-query";

import type { ActionEnvelope, CallOptions } from "../action-client.js";
import { ACTION_QUERY_PREFIX } from "../query-keys.js";
import type { RegisteredActions } from "../register.js";
import type { ActionQueryContext } from "./action-query.js";
import { readTagsOf } from "./sync.js";

export interface ShownRead {
  readonly query: Query;
  readonly request: ReadRequest;
}

/** The action queries the page shows, to name on a write so it answers with them fresh. */
export function shownReads(queryClient: QueryClient): ShownRead[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ACTION_QUERY_PREFIX, type: "active" })
    .slice(0, MAX_REFRESHED_READS)
    .map((query) => ({ query, request: [String(query.queryKey[2]), query.queryKey[3]] }));
}

/**
 * Brings the cache up to date after a write. The reads the server ran again go straight in;
 * a shown read it could not run, or one whose reads are unknown here, is fetched again, and
 * this waits for it; data nothing shows that the write changed is marked out of date. A
 * server that did not say what the write changed gets every action query fetched again.
 */
export async function applyWrite(
  queryClient: QueryClient,
  shown: readonly ShownRead[],
  envelope: ActionEnvelope<unknown>,
): Promise<void> {
  const { writes, refreshed } = envelope;
  if (!writes || !refreshed) {
    await queryClient.invalidateQueries({ queryKey: ACTION_QUERY_PREFIX });
    return;
  }
  const registry = readTagsOf(queryClient);
  const changed = (query: Query) => {
    const tags = registry.tagsFor(query.queryHash);
    return (
      tags === undefined ||
      tags.some((read) => writes.some((write) => tagsOverlap(read, write)))
    );
  };

  const refetch: Query[] = [];
  await Promise.all(
    shown.map(async ({ query }, index) => {
      const fresh = refreshed[index];
      // The server judged it untouched by the write.
      if (fresh === null) return;
      if (fresh === undefined) {
        if (changed(query)) refetch.push(query);
        return;
      }
      if ("error" in fresh) {
        refetch.push(query);
        return;
      }
      // A fetch that started before the write would land older data over it.
      if (query.state.fetchStatus === "fetching") {
        await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true });
      }
      registry.record(query.queryHash, fresh.tags, fresh.cursor);
      queryClient.setQueryData(query.queryKey, fresh.data);
    }),
  );

  const named = new Set(shown.map(({ query }) => query.queryHash));
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ACTION_QUERY_PREFIX })) {
    if (named.has(query.queryHash) || !changed(query)) continue;
    void queryClient.invalidateQueries({
      queryKey: query.queryKey,
      exact: true,
      refetchType: "none",
    });
  }
  await Promise.all(
    refetch.map((query) =>
      queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }),
    ),
  );
}

type Name = keyof RegisteredActions & string;

/**
 * Calls an action and brings the page up to date with what it changed, in the same round
 * trip: the write answers with the reads the page shows that it touched. What
 * `useActionMutation` runs; for a flow of several calls behind one button, call each with it.
 */
export async function callAndRefresh<K extends Name>(
  { client, queryClient }: ActionQueryContext,
  name: K,
  input: ActionInput<RegisteredActions[K]>,
  options: Omit<CallOptions, "refresh"> = {},
): Promise<ActionOutput<RegisteredActions[K]>> {
  const shown = shownReads(queryClient);
  const envelope = await client.invoke(name, input, {
    ...options,
    refresh: shown.map(({ request }) => request),
  });
  await applyWrite(queryClient, shown, envelope).catch(() =>
    queryClient.invalidateQueries({ queryKey: ACTION_QUERY_PREFIX }),
  );
  return envelope.data;
}
