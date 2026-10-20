import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  use,
} from "react";

import { useChatRuntime } from "./context.js";

type AskItem = Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>;

const AskScope = createContext<AskItem | undefined>(undefined);

const report = (error: unknown) =>
  console.error("[parlor] The chat could not answer:", error);

export interface ChatAskProps extends ComponentProps<"div"> {
  readonly item: AskItem;
}

/**
 * The agent's own permission prompt or question: `role="group"` named by its question.
 * `data-approval` is `presence` (answering triggers the OS prompt) or `computer` (answered
 * on the computer; choices disabled). `data-state` is `open`, `answered` or `closed`.
 * Escape declines.
 */
export function Ask({ item, onKeyDown, ...props }: ChatAskProps): ReactNode {
  const runtime = useChatRuntime("Chat.Ask");
  const decline = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape") return;
    const rejection = item.choices.find((choice) => choice.effect.startsWith("reject"));
    if (!rejection || item.answer.state !== "open" || item.approval === "computer")
      return;
    event.preventDefault();
    event.stopPropagation();
    runtime.answer(item.id, rejection.id).catch(report);
  };
  return (
    <AskScope value={item}>
      <div
        role="group"
        aria-label={item.question}
        tabIndex={-1}
        {...props}
        data-approval={item.approval}
        data-state={item.answer.state}
        onKeyDown={decline}
      />
    </AskScope>
  );
}

export interface ChatAskChoiceProps extends ComponentProps<"button"> {
  readonly choice: AskItem["choices"][number];
}

/** `type="button"`; answers the enclosing ask with this choice. */
export function AskChoice({ choice, onClick, ...props }: ChatAskChoiceProps): ReactNode {
  const runtime = useChatRuntime("Chat.AskChoice");
  const ask = use(AskScope);
  if (!ask) throw new Error("Chat.AskChoice must be rendered inside Chat.Ask.");
  return (
    <button
      type="button"
      disabled={ask.approval === "computer" || ask.answer.state !== "open"}
      data-effect={choice.effect}
      aria-pressed={
        ask.answer.state === "answered" ? ask.answer.choice === choice.id : undefined
      }
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) runtime.answer(ask.id, choice.id).catch(report);
      }}
    />
  );
}
