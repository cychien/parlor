import type { AgentUiClient } from "@parlor/agent-ui/client";
import { createSyncClient, type SyncClient } from "@parlor/sync/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import type { ActionClient } from "../action-client.js";
import type { RegisteredActions } from "../register.js";
import { createAgentUiRuntime } from "./agent-ui/runtime.js";
import { invalidateForEvents, ReadTagRegistry } from "./sync.js";

interface FrameworkContextValue {
  readonly client: ActionClient<RegisteredActions>;
  readonly readTags: ReadTagRegistry;
  readonly agentUi: AgentUiClient;
}

const FrameworkContext = createContext<FrameworkContextValue | null>(null);

export interface FrameworkProviderProps {
  readonly client: ActionClient<RegisteredActions>;
  readonly queryClient?: QueryClient | undefined;
  readonly sync?: boolean | undefined;
  readonly router?: AnyRouter | undefined;
  readonly children: ReactNode;
}

export function FrameworkProvider({
  client,
  queryClient,
  sync = true,
  router,
  children,
}: FrameworkProviderProps) {
  const [ownQueryClient] = useState(() => queryClient ?? new QueryClient());
  const [value] = useState<FrameworkContextValue>(() => ({
    client,
    readTags: new ReadTagRegistry(),
    agentUi: createAgentUiRuntime({ client, queryClient: ownQueryClient, router }),
  }));

  useEffect(() => value.readTags.attach(ownQueryClient), [value, ownQueryClient]);

  useEffect(() => value.agentUi.start(), [value]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let uninstall: (() => void) | undefined;
    let active = true;
    void import("./agent-ui/dev.js").then(({ installAgentUiDevtools }) => {
      if (active)
        uninstall = installAgentUiDevtools(value.agentUi, value.client.clientId);
    });
    return () => {
      active = false;
      uninstall?.();
    };
  }, [value]);

  useEffect(() => {
    if (!sync) return;
    const syncClient: SyncClient = createSyncClient({
      request: (path, init) => client.request(path, init),
      basePath: client.basePath,
      clientId: client.clientId,
      onEvents: (events) =>
        void invalidateForEvents(ownQueryClient, value.readTags, events),
      isHidden: () => globalThis.document?.visibilityState === "hidden",
      channels: [value.agentUi],
    });
    syncClient.start();
    return () => syncClient.stop();
  }, [client, ownQueryClient, sync, value]);

  return (
    <FrameworkContext.Provider value={value}>
      <QueryClientProvider client={ownQueryClient}>{children}</QueryClientProvider>
    </FrameworkContext.Provider>
  );
}

export function useFramework(): FrameworkContextValue {
  const value = useContext(FrameworkContext);
  if (!value) throw new Error("useActionClient must be used inside <FrameworkProvider>");
  return value;
}

export function useActionClient(): ActionClient<RegisteredActions> {
  return useFramework().client;
}
