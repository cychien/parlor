import { type AgentConfirmation, Chat, useActionQuery } from "@parlor/client/react";
import type { MouseEvent } from "react";

const ACTION_VERBS: Readonly<Record<string, string>> = {
  deleteTask: "delete a task",
};

export function focusComposer(event: MouseEvent<HTMLElement>) {
  event.currentTarget.closest(".agent-sidebar")?.querySelector("textarea")?.focus();
}

const idOf = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  "id" in input &&
  typeof input.id === "string"
    ? input.id
    : undefined;

function DeleteTaskQuestion({ id }: { readonly id: string }) {
  const task = useActionQuery("getTask", { id });
  if (task.error?.code === "not_found") return <>This task no longer exists</>;
  if (!task.data) return <>Delete this task?</>;
  return <>Delete the task &ldquo;{task.data.title}&rdquo;?</>;
}

function Question({ confirmation }: { readonly confirmation: AgentConfirmation }) {
  const id = idOf(confirmation.input);
  if (confirmation.action === "deleteTask" && id !== undefined) {
    return <DeleteTaskQuestion id={id} />;
  }
  return <>{confirmation.description}</>;
}

export function ConfirmationCard({
  confirmation,
}: {
  readonly confirmation: AgentConfirmation;
}) {
  const agent = confirmation.origin.name ?? "An agent";
  const id = idOf(confirmation.input);
  const verb = ACTION_VERBS[confirmation.action] ?? "make a change";
  const known = confirmation.action in ACTION_VERBS;
  return (
    <Chat.Confirm confirmation={confirmation} className="card">
      <Chat.ConfirmLabel className="card-who">
        <strong>{agent}</strong> wants to {verb}
      </Chat.ConfirmLabel>
      <p className="card-what">
        <Question confirmation={confirmation} />
      </p>
      <p className="card-ref">
        <code>
          {confirmation.action}
          {id === undefined ? null : ` · ${id}`}
        </code>
      </p>
      {known ? null : (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(confirmation.input, null, 2)}</pre>
        </details>
      )}
      <div className="actions">
        <Chat.Approve className="primary" onClick={focusComposer}>
          Approve
        </Chat.Approve>
        <Chat.Decline onClick={focusComposer}>Decline</Chat.Decline>
      </div>
    </Chat.Confirm>
  );
}
