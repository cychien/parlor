import type { ActionError, ActionInput, ActionOutput } from "@parlor/core";
import {
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

import type { RegisteredActions } from "../register.js";
import { type ActionQueryContext, actionQueryOptions } from "./action-query.js";
import { useFramework } from "./provider.js";
import { callAndRefresh } from "./write-refresh.js";

type Actions = RegisteredActions;
type Name = keyof Actions & string;

export type ActionQueryOptions<K extends Name> = Omit<
  UseQueryOptions<ActionOutput<Actions[K]>, ActionError>,
  "queryKey" | "queryFn"
>;

export function useActionQuery<K extends Name>(
  name: K,
  input: ActionInput<Actions[K]>,
  options?: ActionQueryOptions<K>,
): UseQueryResult<ActionOutput<Actions[K]>, ActionError> {
  return useQuery({
    ...actionQueryOptions(useActionQueryContext(), name, input),
    ...options,
  });
}

export type ActionSuspenseQueryOptions<K extends Name> = Omit<
  UseSuspenseQueryOptions<ActionOutput<Actions[K]>, ActionError>,
  "queryKey" | "queryFn"
>;

/**
 * `useActionQuery` as a TanStack Query `useSuspenseQuery`: `data` is always there. It suspends
 * until the action answers, unless a route `loader` already ran `ensureActionQueryData`.
 */
export function useActionSuspenseQuery<K extends Name>(
  name: K,
  input: ActionInput<Actions[K]>,
  options?: ActionSuspenseQueryOptions<K>,
): UseSuspenseQueryResult<ActionOutput<Actions[K]>, ActionError> {
  return useSuspenseQuery({
    ...actionQueryOptions(useActionQueryContext(), name, input),
    ...options,
  });
}

function useActionQueryContext(): ActionQueryContext {
  return { client: useFramework().client, queryClient: useQueryClient() };
}

export type ActionMutationOptions<K extends Name> = Omit<
  UseMutationOptions<ActionOutput<Actions[K]>, ActionError, ActionInput<Actions[K]>>,
  "mutationFn"
>;

export function useActionMutation<K extends Name>(
  name: K,
  options?: ActionMutationOptions<K>,
): UseMutationResult<ActionOutput<Actions[K]>, ActionError, ActionInput<Actions[K]>> {
  const { client } = useFramework();
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    // The page is fresh, with what the write changed, before `onSuccess` runs.
    mutationFn: (input) => callAndRefresh({ client, queryClient }, name, input),
  });
}
