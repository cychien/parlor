import { type AgentUiClient, createAgentUiClient } from "@parlor/agent-ui/client";
import { detectPlatform } from "@parlor/capabilities";
import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";

import type { ActionClient } from "../../action-client.js";
import { ACTION_QUERY_PREFIX } from "../../query-keys.js";
import type { RegisteredActions } from "../../register.js";

export interface AgentUiRuntimeInput {
  readonly client: ActionClient<RegisteredActions>;
  readonly queryClient: QueryClient;
  readonly router: AnyRouter | undefined;
}

function fetchingActions(queryClient: QueryClient): number {
  return queryClient.isFetching({ queryKey: ACTION_QUERY_PREFIX });
}

function actionsSettled(queryClient: QueryClient, timeoutMs: number): Promise<void> {
  if (fetchingActions(queryClient) === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (fetchingActions(queryClient) === 0) done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

export function createAgentUiRuntime({
  client,
  queryClient,
  router,
}: AgentUiRuntimeInput): AgentUiClient {
  return createAgentUiClient({
    router,
    queries: {
      active: () =>
        queryClient
          .getQueryCache()
          .findAll({ queryKey: ACTION_QUERY_PREFIX, type: "active" })
          .map((query) => ({
            action: String(query.queryKey[ACTION_QUERY_PREFIX.length]),
            input: query.queryKey[ACTION_QUERY_PREFIX.length + 1] ?? {},
            status: query.state.status,
          })),
      settled: (timeoutMs) => actionsSettled(queryClient, timeoutMs),
    },
    send: async (message) => {
      const response = await client.request(`${client.basePath}/ui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        keepalive: message.type !== "reply",
      });
      return response.status === 200 ? response.text() : undefined;
    },
    platform: detectPlatform(),
    dev: import.meta.env.DEV,
  });
}
