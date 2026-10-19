import type { AgentActivity } from "@parlor/agent-ui/client";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

import { type AgentActivityState, deriveActivityState } from "./activity-state.js";
import { useAgentActivity } from "./use-agent-activity.js";

const DEFAULT_LINGER_MS = 2000;

function useActivityState(lingerMs: number): AgentActivityState {
  const activity = useAgentActivity();
  const [faded, setFaded] = useState<AgentActivity["last"]>();
  const { busy, last } = activity;
  useEffect(() => {
    if (busy || !last) return;
    const timer = setTimeout(() => setFaded(last), lingerMs);
    return () => clearTimeout(timer);
  }, [busy, last, lingerMs]);
  return deriveActivityState(activity, faded);
}

export interface ChatActivityProps extends Omit<ComponentProps<"span">, "children"> {
  /** Milliseconds a finished event stays `done` or `refused` before it reads `idle`. */
  readonly linger?: number;
  readonly children: (state: AgentActivityState) => ReactNode;
}

/**
 * A polite live region that says what an agent is doing on this screen. The app writes the
 * words; style it through `[data-state]` and `[data-op]`.
 */
export function Activity({
  linger = DEFAULT_LINGER_MS,
  children,
  ...props
}: ChatActivityProps) {
  const state = useActivityState(linger);
  return (
    <span
      role="status"
      aria-live="polite"
      {...props}
      data-state={state.status}
      data-op={state.status === "idle" ? undefined : state.op}
    >
      {children(state)}
    </span>
  );
}
