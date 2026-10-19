import type { AgentOrigin, UiErrorCode } from "@parlor/agent-ui";
import type { AgentActivity, AgentActivityKind } from "@parlor/agent-ui/client";

export type AgentActivityState =
  | { readonly status: "idle" }
  | {
      readonly status: "busy";
      readonly op: AgentActivityKind;
      readonly origin: AgentOrigin;
    }
  | {
      readonly status: "done";
      readonly op: AgentActivityKind;
      readonly origin: AgentOrigin;
    }
  | {
      readonly status: "refused";
      readonly op: AgentActivityKind;
      readonly origin: AgentOrigin;
      readonly code: UiErrorCode;
    };

export function deriveActivityState(
  { busy, last }: AgentActivity,
  faded: AgentActivity["last"],
): AgentActivityState {
  if (!last) return { status: "idle" };
  const { op, origin, outcome } = last;
  if (busy) return { status: "busy", op, origin };
  if (last === faded) return { status: "idle" };
  if (outcome?.status === "refused") {
    return { status: "refused", op, origin, code: outcome.code };
  }
  return { status: "done", op, origin };
}
