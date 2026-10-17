import type { AgentViewBinding, AnyAgentView } from "@parlor/agent-ui";

export interface AgentViewHandle {
  readonly ref: (element: Element | null) => void;
}

export function useAgentView<D extends AnyAgentView>(
  view: D,
  binding: AgentViewBinding<D>,
): AgentViewHandle {
  void view;
  void binding;
  throw new Error("not implemented");
}
