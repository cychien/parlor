import { type ActionSource, type AnyAction, needsConfirmation } from "./action.js";
import type { Principal } from "./principal.js";

/**
 * What happens to a call before `run`: `ask` waits for the user to approve it in the app,
 * `proceed` runs it, and `refuse` fails it with `confirmation_unavailable` at once.
 */
export type ConfirmationDecision = "ask" | "proceed" | "refuse";

export interface ConfirmationCall {
  readonly name: string;
  readonly action: AnyAction;
  readonly principal: Principal;
  readonly source: ActionSource;
}

/** Decides, once per call after its input is valid, whether someone must approve it first. */
export type ConfirmationPolicy = (call: ConfirmationCall) => ConfirmationDecision;

/**
 * Asks before an agent's call to a `confirm: true` action and refuses a key's call to one,
 * since nobody can approve for a key. Everything else proceeds.
 */
export const defaultConfirmationPolicy: ConfirmationPolicy = ({
  action,
  principal,
  source,
}) => {
  if (action.confirm === true && principal.kind === "key") return "refuse";
  return needsConfirmation(action, source) ? "ask" : "proceed";
};

/** An action's description as an agent reads it: what a call meets under `decision`. */
export function agentDescription(
  description: string,
  decision: ConfirmationDecision,
): string {
  switch (decision) {
    case "ask":
      return `${description} When an agent calls it, the user must approve it in the app first; the call waits for that answer and fails with declined, confirmation_timeout or confirmation_unavailable without running.`;
    case "refuse":
      return `${description} It needs a person's approval, which nobody can give for this caller, so a call fails with confirmation_unavailable without running.`;
    case "proceed":
      return description;
  }
}
