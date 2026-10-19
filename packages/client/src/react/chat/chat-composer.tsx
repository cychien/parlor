import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { canSend, useChatRuntime, useChatState } from "./context.js";

const report = (error: unknown) =>
  console.error("[parlor] The chat could not do that:", error);

/** A `<form>` whose submit sends the draft; `data-running` while a turn runs. */
export function Composer({ onSubmit, ...props }: ComponentProps<"form">): ReactNode {
  const runtime = useChatRuntime("Chat.Composer");
  const state = useChatState("Chat.Composer");
  const submit = (
    event: Parameters<NonNullable<ComponentProps<"form">["onSubmit"]>>[0],
  ) => {
    onSubmit?.(event);
    event.preventDefault();
    if (canSend(state)) runtime.send().catch(report);
  };
  return (
    <form
      {...props}
      onSubmit={submit}
      data-running={state.status === "running" ? "" : undefined}
    />
  );
}

/**
 * A `<textarea>` bound to the draft: Enter sends, Shift+Enter breaks the line, IME
 * composition never sends. Disabled while no agent can be chosen.
 */
export function Input({
  onChange,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "defaultValue">): ReactNode {
  const runtime = useChatRuntime("Chat.Input");
  const state = useChatState("Chat.Input");
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend(state)) runtime.send().catch(report);
  };
  return (
    <textarea
      aria-label="Message"
      disabled={state.agent === undefined || state.status === "unavailable"}
      {...props}
      value={state.draft}
      onChange={(event) => {
        onChange?.(event);
        runtime.setDraft(event.target.value);
      }}
      onKeyDown={keyDown}
    />
  );
}

/** `type="submit"`; disabled while the draft is empty or no agent is chosen. */
export function Send({ children, ...props }: ComponentProps<"button">): ReactNode {
  const state = useChatState("Chat.Send");
  return (
    <button type="submit" disabled={!canSend(state)} {...props}>
      {children ?? "Send"}
    </button>
  );
}

/** `type="button"`; rendered only while a turn runs. Stops it, keeping the partial text. */
export function Stop({
  children,
  onClick,
  ...props
}: ComponentProps<"button">): ReactNode {
  const runtime = useChatRuntime("Chat.Stop");
  const state = useChatState("Chat.Stop");
  if (state.status !== "running") return null;
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) runtime.stop().catch(report);
      }}
    >
      {children ?? "Stop"}
    </button>
  );
}
