import {
  type AgentConfirmation,
  Chat,
  useActionQuery,
  useAgentConfirmations,
  useAgentView,
} from "@parlor/client/react";
import { useCallback, useId, useRef, useState } from "react";

import { agentPanel } from "./views.js";

export function AgentPanel() {
  const dialogId = useId();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useAgentConfirmations().length;
  const { ref } = useAgentView(agentPanel, { get: () => ({ open }) });
  const attach = useCallback(
    (element: HTMLDialogElement | null) => {
      dialog.current = element;
      ref(element);
    },
    [ref],
  );
  return (
    <>
      <button
        type="button"
        className="agent-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        aria-label={pending > 0 ? `Agent, ${pending} pending` : undefined}
        data-pending={pending > 0 ? pending : undefined}
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        Agent
        {pending > 0 ? <span className="badge">{pending}</span> : null}
      </button>
      <dialog
        id={dialogId}
        ref={attach}
        className="agent-panel"
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
      >
        <header>
          <h2 id={titleId}>Agent</h2>
          <form method="dialog">
            <button type="submit">Close</button>
          </form>
        </header>
        <div className="agent-panel-body">
          <Chat.Confirmations
            className="confirmations"
            empty={
              <p className="empty">
                No requests from agents.
                <span>An agent asks here before it changes anything.</span>
              </p>
            }
          >
            {(confirmation) => <ConfirmationCard confirmation={confirmation} />}
          </Chat.Confirmations>
        </div>
      </dialog>
    </>
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
        <Chat.Approve className="primary">Approve</Chat.Approve>
        <Chat.Decline>Decline</Chat.Decline>
      </div>
    </Chat.Confirm>
  );
}
