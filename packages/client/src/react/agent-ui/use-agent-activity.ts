import type { AgentActivity } from "@parlor/agent-ui/client";
import { useSyncExternalStore } from "react";

import { useFramework } from "../provider.js";

export function useAgentActivity(): AgentActivity {
  const { activity } = useFramework().agentUi;
  return useSyncExternalStore(activity.subscribe, activity.get, activity.get);
}
