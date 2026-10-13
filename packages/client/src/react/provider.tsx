import { createSyncClient, type SyncClient } from "@parlor/sync/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import type { ActionClient } from "../action-client.js";
import type { RegisteredActions } from "../register.js";
import { invalidateForEvents, ReadTagRegistry } from "./sync.js";

interface FrameworkContextValue {
  readonly client: ActionClient<RegisteredActions>;
  readonly readTags: ReadTagRegistry;
}

const FrameworkContext = createContext<FrameworkContextValue | null>(null);

export interface FrameworkProviderProps {
  readonly client: ActionClient<RegisteredActions>;
  readonly queryClient?: QueryClient | undefined;
  readonly sync?: boolean | undefined;
  readonly children: ReactNode;
}

export function FrameworkProvider({
  client,
  queryClient,
  sync = true,
  children,
}: FrameworkProviderProps) {
  const [ownQueryClient] = useState(() => queryClient ?? new QueryClient());
  const [value] = useState<FrameworkContextValue>(() => ({
    client,
    readTags: new ReadTagRegistry(),
  }));

  useEffect(() => value.readTags.attach(ownQueryClient), [value, ownQueryClient]);

  useEffect(() => {
    if (!sync) return;
    const syncClient: SyncClient = createSyncClient({
      request: (path, init) => client.request(path, init),
      basePath: client.basePath,
      clientId: client.clientId,
      onEvents: (events) =>
        void invalidateForEvents(ownQueryClient, value.readTags, events),
      isHidden: () => globalThis.document?.visibilityState === "hidden",
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
