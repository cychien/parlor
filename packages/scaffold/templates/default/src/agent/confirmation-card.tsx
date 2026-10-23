import { type AgentConfirmation, Chat } from "@parlor/client/react";
import type { MouseEvent } from "react";

export function focusComposer(event: MouseEvent<HTMLElement>) {
  event.currentTarget.closest("section")?.querySelector("textarea")?.focus();
}

export function ConfirmationCard({
  confirmation,
}: {
  readonly confirmation: AgentConfirmation;
}) {
  const agent = confirmation.origin.name ?? "An agent";
  return (
    <Chat.Confirm
      confirmation={confirmation}
      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <Chat.ConfirmLabel>
        <strong>{agent}</strong> wants to run <code>{confirmation.action}</code>
      </Chat.ConfirmLabel>
      <p>{confirmation.description}</p>
      <details>
        <summary className="cursor-pointer text-zinc-500">Details</summary>
        <pre className="mt-1 overflow-x-auto text-xs">
          {JSON.stringify(confirmation.input, null, 2)}
        </pre>
      </details>
      <div className="flex gap-2">
        <Chat.Approve
          onClick={focusComposer}
          className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white"
        >
          Approve
        </Chat.Approve>
        <Chat.Decline onClick={focusComposer} className="rounded-md border px-3 py-1">
          Decline
        </Chat.Decline>
      </div>
    </Chat.Confirm>
  );
}
