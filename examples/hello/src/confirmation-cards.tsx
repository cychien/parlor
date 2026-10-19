import {
  type AgentConfirmation,
  useActionQuery,
  useAgentConfirmations,
} from "@parlor/client/react";
import { useId } from "react";

export function ConfirmationCards() {
  const confirmations = useAgentConfirmations();
  return (
    <div aria-live="polite" className="confirmations">
      {confirmations.map((confirmation) => (
        <ConfirmationCard key={confirmation.id} confirmation={confirmation} />
      ))}
    </div>
  );
}

const ACTION_VERBS: Readonly<Record<string, string>> = {
  deleteTask: "delete a task",
};

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

function ConfirmationCard({
  confirmation,
}: {
  readonly confirmation: AgentConfirmation;
}) {
  const whoId = useId();
  const agent = confirmation.origin.name ?? "An agent";
  const id = idOf(confirmation.input);
  const verb = ACTION_VERBS[confirmation.action] ?? "make a change";
  const known = confirmation.action in ACTION_VERBS;
  return (
    <div
      role="group"
      aria-labelledby={whoId}
      className="card"
      onKeyDown={(event) => {
        if (event.key === "Escape") confirmation.decline();
      }}
    >
      <p id={whoId} className="card-who">
        <strong>{agent}</strong> wants to {verb}
      </p>
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
        <button type="button" className="primary" onClick={confirmation.approve}>
          Approve
        </button>
        <button type="button" onClick={confirmation.decline}>
          Decline
        </button>
      </div>
    </div>
  );
}
