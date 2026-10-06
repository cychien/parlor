import type { ActionError, ActionInput, ActionOutput } from "@fw/core";
import {
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { ACTION_QUERY_PREFIX, actionQueryKey } from "../query-keys.js";
import type { RegisteredActions } from "../register.js";
import { useActionClient } from "./provider.js";

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
  const client = useActionClient();
  return useQuery({
    ...options,
    queryKey: actionQueryKey(name, input),
    queryFn: ({ signal }) => client.call(name, input, { signal }),
  });
}

export type ActionMutationOptions<K extends Name> = Omit<
  UseMutationOptions<ActionOutput<Actions[K]>, ActionError, ActionInput<Actions[K]>>,
  "mutationFn"
>;

export function useActionMutation<K extends Name>(
  name: K,
  options?: ActionMutationOptions<K>,
): UseMutationResult<ActionOutput<Actions[K]>, ActionError, ActionInput<Actions[K]>> {
  const client = useActionClient();
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    mutationFn: (input) => client.call(name, input),
    onSuccess: async (data, variables, onMutateResult, context) => {
      await queryClient.invalidateQueries({ queryKey: ACTION_QUERY_PREFIX });
      await options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}
