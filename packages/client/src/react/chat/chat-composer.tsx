import type { ComponentProps, ReactNode } from "react";

/** A `<form>` whose submit sends the draft; `data-running` while a turn runs. */
export function Composer(props: ComponentProps<"form">): ReactNode {
  void props;
  throw new Error("not implemented");
}

/**
 * A `<textarea>` bound to the draft: Enter sends, Shift+Enter breaks the line, IME
 * composition never sends. Disabled while no agent can be chosen.
 */
export function Input(
  props: Omit<ComponentProps<"textarea">, "value" | "defaultValue">,
): ReactNode {
  void props;
  throw new Error("not implemented");
}

/** `type="submit"`; disabled while the draft is empty or no agent is chosen. */
export function Send(props: ComponentProps<"button">): ReactNode {
  void props;
  throw new Error("not implemented");
}

/** `type="button"`; rendered only while a turn runs. Stops it, keeping the partial text. */
export function Stop(props: ComponentProps<"button">): ReactNode {
  void props;
  throw new Error("not implemented");
}
