import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";

import type { ActionClient } from "../action-client.js";
import type { RegisteredActions } from "../register.js";

const ActionClientContext = createContext<ActionClient<RegisteredActions> | null>(null);

export interface FrameworkProviderProps {
  readonly client: ActionClient<RegisteredActions>;
  readonly queryClient?: QueryClient | undefined;
  readonly children: ReactNode;
}

export function FrameworkProvider({
  client,
  queryClient,
  children,
}: FrameworkProviderProps) {
  const [ownQueryClient] = useState(() => queryClient ?? new QueryClient());
  return (
    <ActionClientContext.Provider value={client}>
      <QueryClientProvider client={ownQueryClient}>{children}</QueryClientProvider>
    </ActionClientContext.Provider>
  );
}

export function useActionClient(): ActionClient<RegisteredActions> {
  const client = useContext(ActionClientContext);
  if (!client) throw new Error("useActionClient must be used inside <FrameworkProvider>");
  return client;
}
