import type { AgentConfirmation } from "@parlor/agent-ui/client";
import { useSyncExternalStore } from "react";

import { useFramework } from "../provider.js";

/**
 * The agent requests waiting for this user's approval on this client, newest last. Headless:
 * the app draws the card and calls `approve` or `decline`. Rendering this hook is what tells
 * the server this client can show a confirmation; render it where it is always mounted.
 */
export function useAgentConfirmations(): readonly AgentConfirmation[] {
  const { confirmations } = useFramework().agentUi;
  return useSyncExternalStore(
    confirmations.subscribe,
    confirmations.get,
    confirmations.get,
  );
}
