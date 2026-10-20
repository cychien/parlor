import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  use,
  useMemo,
} from "react";

import { type AskField, askFields, askValues } from "./ask-fields.js";
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

const isAllow = (choice: AskItem["choices"][number]) => choice.effect.startsWith("allow");

export type ChatAskFormProps = ComponentProps<"form">;

/**
 * A form ask's `<form>`: one `<input name="{property}">` per property of its schema (`number`
 * for numbers and integers, `checkbox` for booleans, text otherwise). Submitting answers the
 * ask with its allow choice and the values typed per the schema. Its children, a submit
 * button for one, go after the inputs. Everything is disabled once the ask is not open or
 * is answered on the computer. Renders nothing for an ask without a form.
 */
export function AskForm({ onSubmit, children, ...props }: ChatAskFormProps): ReactNode {
  const runtime = useChatRuntime("Chat.AskForm");
  const ask = use(AskScope);
  if (!ask) throw new Error("Chat.AskForm must be rendered inside Chat.Ask.");
  const { form } = ask;
  const fields = useMemo(() => (form ? askFields(form) : []), [form]);
  const accept = ask.choices.find(isAllow);
  if (!form || !accept) return null;
  return (
    <form
      {...props}
      onSubmit={(event) => {
        onSubmit?.(event);
        event.preventDefault();
        runtime
          .answer(ask.id, accept.id, askValues(fields, event.currentTarget))
          .catch(report);
      }}
    >
      <fieldset disabled={ask.approval === "computer" || ask.answer.state !== "open"}>
        {fields.map((field) => (
          <AskInput key={field.name} field={field} />
        ))}
        {children}
      </fieldset>
    </form>
  );
}

function AskInput({ field }: { readonly field: AskField }): ReactNode {
  return (
    <label data-type={field.type}>
      <span>{field.label}</span>
      <input
        name={field.name}
        type={field.type}
        required={field.required && field.type !== "checkbox"}
        step={field.type === "number" ? (field.integer ? 1 : "any") : undefined}
      />
    </label>
  );
}
