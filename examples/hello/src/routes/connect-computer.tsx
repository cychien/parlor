import { type ComputerConnection, parseComputerConnection } from "@parlor/auth/client";
import { useSession } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { auth } from "../auth.js";

export const Route = createFileRoute("/connect-computer")({
  staticData: {
    description:
      "Approve a computer that ran `parlor-host connect`, so its coding agents answer in the sidebar.",
  },
  component: ConnectComputer,
});

function ConnectComputer() {
  const [connection] = useState<ComputerConnection | undefined>(() =>
    parseComputerConnection(window.location.search),
  );
  const session = useSession();
  const [agentTools, setAgentTools] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!connection) {
    return (
      <section aria-label="Connect a computer" className="stack">
        <h1>Connect a computer</h1>
        <p>This link is incomplete. Run connect on your computer again.</p>
      </section>
    );
  }
  if (connection.step === "connected") {
    return (
      <section aria-label="Computer connected" className="stack">
        <h1>Computer connected</h1>
        <p>Its coding agents are ready in the agent sidebar.</p>
        {connection.agentTools ? (
          <p>
            In Claude Code or Codex there, ask them to “use{" "}
            <code>{connection.agentTools}</code> to …”.
          </p>
        ) : null}
        <p>
          <Link to="/">Back to Hello</Link>
        </p>
      </section>
    );
  }

  const { request } = connection;
  const answer = async (decision: "connect" | "cancel") => {
    setPending(true);
    setError(undefined);
    try {
      window.location.assign(
        await auth.answerComputerConnection(request, decision, { agentTools }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };
  const account = session.status === "signed-in" ? session.user.email : "your account";

  return (
    <section aria-label="Connect a computer" className="stack">
      <h1>Connect {request.hostName}?</h1>
      <p>
        The coding agents on <strong>{request.hostName}</strong> ({request.platform}) will
        take your prompts from Hello as {account}. Continue only if you just ran connect
        there.
      </p>
      {request.offersAgentTools ? (
        <label>
          <input
            type="checkbox"
            checked={agentTools}
            onChange={(event) => setAgentTools(event.target.checked)}
          />{" "}
          Also let Claude Code and Codex on this computer use Hello when you name it.
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <p>
        <button type="button" disabled={pending} onClick={() => void answer("cancel")}>
          Cancel
        </button>{" "}
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={() => void answer("connect")}
        >
          Connect
        </button>
      </p>
    </section>
  );
}
