import type { TurnState } from "@parlor/chat";
import {
  type AgentConfirmation,
  Chat,
  type ChatItem,
  useChat,
} from "@parlor/client/react";

import { ConfirmationCard, focusComposer } from "./agent-requests.js";

export default function AgentSidebar() {
  return (
    <Chat.Root>
      <Computers />
      <Chat.Confirmations className="requests">
        {(confirmation) =>
          confirmation.threadId === undefined ? (
            <ConfirmationCard confirmation={confirmation} />
          ) : null
        }
      </Chat.Confirmations>
      <Chat.Thread className="thread" empty={<ThreadEmpty />}>
        {(item) => <Item item={item} />}
      </Chat.Thread>
      <Composer />
    </Chat.Root>
  );
}

function Computers() {
  const { agents, agent, choose, connect, hosts } = useChat();
  if (agents.length === 0) {
    return (
      <div className="sidebar-note" data-state="no-agents">
        <p className="sidebar-note-title">
          {hosts.length === 0 ? "No computer connected" : "No agent ready"}
        </p>
        <p>
          {hosts.length === 0
            ? "Connect a computer to your account to chat with an agent here."
            : "None of your connected computers has an agent set up."}
        </p>
        {connect.kind === "here" ? (
          <button type="button" onClick={() => void connect.start()}>
            Use agents on this computer
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="picker">
      <select
        name="agent"
        aria-label="Agent"
        value={agent?.key ?? ""}
        onChange={(event) => choose(event.target.value)}
      >
        {agent ? null : (
          <option value="" disabled>
            Choose an agent
          </option>
        )}
        {agents.map((choice) => (
          <option
            key={choice.key}
            value={choice.key}
            disabled={!choice.online || !choice.ready}
          >
            {choice.name} on {choice.hostName}
            {!choice.online ? " (offline)" : !choice.ready ? " (not ready)" : ""}
          </option>
        ))}
      </select>
      {agent?.problem ? <p className="problem">{agent.problem}</p> : null}
      {!agent && agents.every((choice) => !choice.online) ? (
        <p className="problem">Your computer is offline.</p>
      ) : null}
    </div>
  );
}

function ThreadEmpty() {
  const { status, agents } = useChat();
  if (status === "loading") return <p className="thread-empty">Loading...</p>;
  return (
    <p className="thread-empty">
      {agents.length === 0
        ? "Your conversation with an agent shows up here."
        : "Ask your agent to do something in Hello."}
    </p>
  );
}

function Composer() {
  const { status, error } = useChat();
  return (
    <Chat.Composer className="composer">
      <Chat.Input
        name="message"
        aria-label="Message"
        placeholder="Message your agent"
        rows={2}
        autoFocus
      />
      {error ? (
        <p className="problem" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-bar">
        <p className="composer-status" role="status">
          {status === "sending" ? "Sending..." : status === "running" ? "Working..." : ""}
        </p>
        <Chat.Stop>Stop</Chat.Stop>
        <Chat.Send className="primary">Send</Chat.Send>
      </div>
    </Chat.Composer>
  );
}

const TURN_STATE: Partial<Record<TurnState, string>> = {
  queued: "Waiting for the computer",
  cancelled: "Stopped",
  failed: "Failed",
};

const TOOL_STATE = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
} as const;

const EVENTS = {
  device_pending: "Waiting for this device to be approved",
  device_rejected: "This device was not approved",
  agent_started: "Agent started",
  agent_exited: "Agent exited",
  agent_switched: "Switched agent",
  host_lost: "Lost contact with the computer",
  turn_failed: "The turn failed",
  answer_rejected: "Your answer was not accepted",
} as const;

function Item({ item }: { readonly item: ChatItem<AgentConfirmation> }) {
  switch (item.kind) {
    case "prompt":
      return (
        <>
          <p className="prompt">{item.text}</p>
          {TURN_STATE[item.state] ? (
            <p className="item-meta">{TURN_STATE[item.state]}</p>
          ) : null}
        </>
      );
    case "reply":
      return (
        <>
          <p className="reply">{item.text}</p>
          {item.interrupted ? <p className="item-meta">Interrupted</p> : null}
        </>
      );
    case "reasoning":
      return <p className="reasoning">{item.text}</p>;
    case "tool":
      return (
        <p className="tool" data-status={item.status}>
          <span className="tool-title">{item.title}</span>
          <span className="tool-state">{TOOL_STATE[item.status]}</span>
          {item.detail ? <span className="tool-detail">{item.detail}</span> : null}
        </p>
      );
    case "plan":
      return (
        <ul className="plan">
          {item.entries.map((entry, index) => (
            <li key={`${index}:${entry.content}`} data-status={entry.status}>
              {entry.content}
            </li>
          ))}
        </ul>
      );
    case "ask":
      return (
        <Chat.Ask item={item} className="card">
          <p className="card-what">{item.question}</p>
          {item.answer.state === "answered" ? (
            <p className="item-meta">Answered</p>
          ) : item.answer.state === "closed" ? (
            <p className="item-meta">No longer needed</p>
          ) : item.approval === "computer" ? (
            <p className="item-meta">Answer on your computer.</p>
          ) : (
            <div className="actions">
              {item.choices.map((choice) => (
                <Chat.AskChoice
                  key={choice.id}
                  choice={choice}
                  className={choice.effect.startsWith("allow") ? "primary" : undefined}
                  onClick={focusComposer}
                >
                  {choice.label}
                </Chat.AskChoice>
              ))}
            </div>
          )}
        </Chat.Ask>
      );
    case "confirm":
      return <ConfirmationCard confirmation={item.confirmation} />;
    case "event":
      return (
        <p className="event">
          {EVENTS[item.event]}
          {item.detail ? `: ${item.detail}` : ""}
        </p>
      );
  }
}
