import type { AgentViewBinding, AnyAgentView, WritableField } from "@parlor/agent-ui";
import { agentFieldsOf, type AnyViewBinding } from "@parlor/agent-ui/client";
import { useEffect, useInsertionEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import { useFramework } from "../provider.js";

export interface AgentViewHandle<D extends AnyAgentView = AnyAgentView> {
  readonly ref: (element: Element | null) => void;
  /**
   * Fields the agent wrote that still hold what it wrote, for the app to style; the user
   * changing a field removes it. Always empty for a read-only view.
   */
  readonly agentFields: ReadonlySet<WritableField<D>>;
}

function committing(binding: AgentViewBinding<AnyAgentView>): AnyViewBinding {
  const { set } = binding;
  if (!set) return binding;
  return {
    key: binding.key,
    get: binding.get,
    set: (next, changed) => flushSync(() => set(next, changed)),
  };
}

export function useAgentView<D extends AnyAgentView>(
  view: D,
  binding: AgentViewBinding<D>,
): AgentViewHandle<D> {
  const { agentUi } = useFramework();
  const erased = committing(binding as unknown as AgentViewBinding<AnyAgentView>);
  const [slot] = useState(() => agentUi.views.track(view, erased));
  useInsertionEffect(() => slot.bind(erased));
  useEffect(() => slot.mount(binding.key), [slot, binding.key]);
  const writes = useSyncExternalStore(slot.subscribeWrites, slot.writes, slot.writes);
  const agentFields = agentFieldsOf(writes, writes.size === 0 ? {} : binding.get());
  return { ref: slot.ref, agentFields } as AgentViewHandle<D>;
}
