import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import type { ComponentProps, ReactNode } from "react";

type AskItem = Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>;

export interface ChatAskProps extends ComponentProps<"div"> {
  readonly item: AskItem;
}

/**
 * The agent's own permission prompt or question: `role="group"` named by its question.
 * `data-approval` is `presence` (answering triggers the OS prompt) or `computer` (answered
 * on the computer; choices disabled). `data-state` is `open`, `answered` or `closed`.
 * Escape declines.
 */
export function Ask(props: ChatAskProps): ReactNode {
  void props;
  throw new Error("not implemented");
}

export interface ChatAskChoiceProps extends ComponentProps<"button"> {
  readonly choice: AskItem["choices"][number];
}

/** `type="button"`; answers the enclosing ask with this choice, signing it first. */
export function AskChoice(props: ChatAskChoiceProps): ReactNode {
  void props;
  throw new Error("not implemented");
}
