import type { ActionError, ActionInput, ActionOutput } from "@parlor/core";
import { hashKey, type QueryClient, queryOptions } from "@tanstack/react-query";

import type { ActionClient } from "../action-client.js";
import { actionQueryKey } from "../query-keys.js";
import type { RegisteredActions } from "../register.js";
import { actionRetry } from "./retry.js";
import { readTagsOf } from "./sync.js";

type Actions = RegisteredActions;
type Name = keyof Actions & string;

/** What reading an action outside a component needs; a router made by `createParlorRouter` passes it to every loader. */
export interface ActionQueryContext {
  readonly client: ActionClient<RegisteredActions>;
  readonly queryClient: QueryClient;
}

/** Sync refetches what a write makes out of date, so action data stays fresh until then. */
const freshUntilInvalidated = ({
  state,
}: {
  readonly state: { readonly data: unknown; readonly isInvalidated: boolean };
}) => (state.data === undefined || state.isInvalidated ? 0 : "static");

/**
 * The query `useActionQuery(name, input)` runs, for `queryClient.prefetchQuery`, `useQueries`
 * and the like. It reads the same cache entry and records the same read tags, so sync keeps it fresh.
 */
export function actionQueryOptions<K extends Name>(
  { client, queryClient }: ActionQueryContext,
  name: K,
  input: ActionInput<Actions[K]>,
) {
  const queryKey = actionQueryKey(name, input);
  return queryOptions<ActionOutput<Actions[K]>, ActionError, ActionOutput<Actions[K]>>({
    queryKey,
    queryFn: async ({ signal, client: cache }) => {
      const envelope = await client.invoke(name, input, { signal });
      readTagsOf(cache).record(hashKey(queryKey), envelope.tags);
      return envelope.data;
    },
    retry: actionRetry(queryClient.getDefaultOptions().queries?.retry),
    ...(queryClient.getDefaultOptions().queries?.staleTime === undefined
      ? { staleTime: freshUntilInvalidated }
      : {}),
  });
}

/**
 * The action's cached data, fetched first when there is none or when a write it reads has
 * invalidated it since. A route `loader` awaits it so the page renders with its data, and
 * `useActionSuspenseQuery` with the same name and input reads it and keeps it fresh.
 */
export function ensureActionQueryData<K extends Name>(
  context: ActionQueryContext,
  name: K,
  input: ActionInput<Actions[K]>,
): Promise<ActionOutput<Actions[K]>> {
  return context.queryClient.query({
    ...actionQueryOptions(context, name, input),
    staleTime: freshUntilInvalidated,
  });
}
