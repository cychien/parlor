import type { AgentViewBinding, AnyAgentView, WritableField } from "@parlor/agent-ui";
import type { AnyViewBinding } from "@parlor/agent-ui/client";
import { useEffect, useInsertionEffect, useState } from "react";

import { useFramework } from "../provider.js";

export interface AgentViewHandle<D extends AnyAgentView = AnyAgentView> {
  readonly ref: (element: Element | null) => void;
  /**
   * Fields the agent wrote that still hold what it wrote, for the app to style; the user
   * changing a field removes it. Always empty for a read-only view.
   */
  readonly agentFields: ReadonlySet<WritableField<D>>;
}

export function useAgentView<D extends AnyAgentView>(
  view: D,
  binding: AgentViewBinding<D>,
): AgentViewHandle<D> {
  const { agentUi } = useFramework();
  const erased = binding as unknown as AnyViewBinding;
  const [slot] = useState(() => agentUi.views.track(view, erased));
  useInsertionEffect(() => slot.bind(erased));
  useEffect(() => slot.mount(binding.key), [slot, binding.key]);
  return { ref: slot.ref } as AgentViewHandle<D>;
}
