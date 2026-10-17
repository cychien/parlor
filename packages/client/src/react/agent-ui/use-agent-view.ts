import type { AgentViewBinding, AnyAgentView } from "@parlor/agent-ui";
import type { AnyViewBinding } from "@parlor/agent-ui/client";
import { useEffect, useInsertionEffect, useState } from "react";

import { useFramework } from "../provider.js";

export interface AgentViewHandle {
  readonly ref: (element: Element | null) => void;
}

export function useAgentView<D extends AnyAgentView>(
  view: D,
  binding: AgentViewBinding<D>,
): AgentViewHandle {
  const { agentUi } = useFramework();
  const erased = binding as unknown as AnyViewBinding;
  const [slot] = useState(() => agentUi.views.track(view, erased));
  useInsertionEffect(() => slot.bind(erased));
  useEffect(() => slot.mount(binding.key), [slot, binding.key]);
  return { ref: slot.ref };
}
