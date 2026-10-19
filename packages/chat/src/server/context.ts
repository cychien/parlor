import type { LoggedItem } from "../items.js";

export const TRANSCRIPT_BUDGET_BYTES = 8 * 1024;

export interface TurnContextInput {
  readonly appName: string;
  readonly appOrigin: string;
  readonly account?:
    | { readonly name: string; readonly email?: string | undefined }
    | undefined;
  readonly device?: { readonly name: string; readonly platform: string } | undefined;
  readonly instructions?: string | undefined;
  /** The thread before this turn, trimmed from its oldest end to the budget. */
  readonly history: readonly LoggedItem[];
}

/**
 * The `<parlor-context>` block before a fresh agent session's first prompt. Built on the
 * backend so every host and agent gets the same words; the transcript tail is what lets a
 * switched or restarted agent continue the thread.
 */
export function turnContext(input: TurnContextInput): string {
  // TODO: who the agent works for and from which device; the app's tools are its actions
  //   plus ui_* acting on the chat's screen; some actions wait for approval in the app;
  //   input.instructions; prompt/reply/tool lines of history newest-first until
  //   TRANSCRIPT_BUDGET_BYTES (UTF-8), then reversed.
  void input;
  throw new Error("not implemented");
}
