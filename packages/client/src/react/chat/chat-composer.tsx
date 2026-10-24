import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { canSend, useChatRuntime, useChatState } from "./context.js";
import type { ChatState } from "./runtime.js";

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
  if (state.status !== "running" && state.status !== "waiting") return null;
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

function statusText({ status, wait, setup, link, presenceDue }: ChatState): string {
  if (setup?.step === "passkey") return "Waiting for the passkey";
  if (link.status === "unlinked") return "Link this device to send messages";
  if (wait) {
    return wait.reason === "offline"
      ? `Waiting for ${wait.hostName} to come online`
      : `Waiting for ${wait.hostName} to approve this device`;
  }
  if (status === "sending") return "Sending...";
  if (status === "running") return "Working...";
  if (presenceDue) return "Sending will ask for Face ID or Touch ID";
  return "";
}

/**
 * The chat's state in words, for a live region: a `p[role=status]` that is empty when
 * there is nothing to say, so a wait never shows without text. `children` replaces the text.
 */
export function Status({ children, ...props }: ComponentProps<"p">): ReactNode {
  const state = useChatState("Chat.Status");
  return (
    <p
      role="status"
      {...props}
      data-status={state.status}
      data-wait={state.wait?.reason}
      data-unavailable={state.unavailable?.reason}
    >
      {children ?? statusText(state)}
    </p>
  );
}
