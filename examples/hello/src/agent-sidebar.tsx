import { isPromptTooLong, PROMPT_LIMIT_MESSAGE, type TurnState } from "@parlor/chat";
import {
  type AgentConfirmation,
  Chat,
  type ChatItem,
  useChat,
} from "@parlor/client/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { ConfirmationCard, focusComposer } from "./agent-requests.js";
import { sidebarView } from "./sidebar-view.js";

export default function AgentSidebar({
  headerActions,
}: {
  readonly headerActions: HTMLElement | null;
}) {
  return (
    <Chat.Root>
      <PublishThread />
      {headerActions ? createPortal(<NewChat />, headerActions) : null}
      <Computers />
      <Threads />
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

function PublishThread() {
  const threadId = useChat().thread?.id;
  useEffect(() => {
    sidebarView.set({ threadId });
    return () => sidebarView.set({ threadId: undefined });
  }, [threadId]);
  return null;
}

function NewChat() {
  const { threads, thread, newThread } = useChat();
  if (threads.length === 0) return null;
  return (
    <button type="button" disabled={thread === undefined} onClick={newThread}>
      New chat
    </button>
  );
}

function Threads() {
  const { threads, thread, openThread } = useChat();
  if (threads.length === 0) return null;
  return (
    <div className="picker">
      <select
        name="thread"
        aria-label="Conversation"
        value={thread?.id ?? ""}
        onChange={(event) => openThread(event.target.value)}
      >
        {thread ? null : (
          <option value="" disabled>
            New conversation
          </option>
        )}
        {threads.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function Computers() {
  const { agents, agent, choose, connect, hosts, status } = useChat();
  if (status === "loading") return null;
  if (status === "unavailable") {
    return (
      <div className="sidebar-note" data-state="unavailable">
        <p className="sidebar-note-title">Chat is not available</p>
        <p>This app could not reach its chat service. Try again in a moment.</p>
      </div>
    );
  }
  if (agents.length === 0) {
    return (
      <div className="sidebar-note" data-state="no-agents">
        <p className="sidebar-note-title">
          {hosts.length === 0 ? "No computer connected" : "No agent ready"}
        </p>
        <p>
          {hosts.length > 0
            ? "None of your connected computers has an agent set up."
            : connect.kind === "command"
              ? "Run this in a terminal on your computer to chat with its agents here:"
              : "Connect a computer to your account to chat with an agent here."}
        </p>
        {connect.kind === "here" ? (
          <button type="button" onClick={() => void connect.start()}>
            Use agents on this computer
          </button>
        ) : (
          <code className="connect-command" data-testid="connect-command">
            {connect.command}
          </code>
        )}
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
  const { status, error, draft } = useChat();
  const problem = isPromptTooLong(draft) ? PROMPT_LIMIT_MESSAGE : error;
  return (
    <Chat.Composer className="composer">
      <Chat.Input
        name="message"
        aria-label="Message"
        placeholder="Message your agent"
        rows={2}
        autoFocus
      />
      {problem ? (
        <p className="problem" role="alert">
          {problem}
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

type Items = readonly ChatItem<AgentConfirmation>[];
type PromptItem = Extract<ChatItem<AgentConfirmation>, { kind: "prompt" }>;
type AskItem = Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>;

function awaitsApproval(items: Items, prompt: PromptItem): boolean {
  if (prompt.state !== "queued" && prompt.state !== "running") return false;
  let waiting = false;
  for (const item of items) {
    if (item.turnId !== prompt.turnId) continue;
    if (item.kind === "event" && item.event === "device_pending") waiting = true;
    else if (item.kind !== "prompt" && item.kind !== "confirm") waiting = false;
  }
  return waiting;
}

function useHostName(hostId: string | undefined): string {
  const { hosts } = useChat();
  return hosts.find((host) => host.id === hostId)?.name ?? "your computer";
}

function PromptMeta({ item }: { readonly item: PromptItem }) {
  const { items, resend } = useChat();
  const hostName = useHostName(item.agent.hostId);
  if (item.failure === "prompt_expired") {
    return (
      <>
        <p className="item-meta">{`Expired before ${hostName} picked it up`}</p>
        <div className="actions">
          <button type="button" onClick={() => void resend(item.id)}>
            Resend
          </button>
        </div>
      </>
    );
  }
  if (awaitsApproval(items, item)) {
    return (
      <p className="item-meta">{`Waiting for ${hostName} to approve this device`}</p>
    );
  }
  const text = TURN_STATE[item.state];
  return text ? <p className="item-meta">{text}</p> : null;
}

function AskActions({ item }: { readonly item: AskItem }) {
  return (
    <div className="actions">
      {item.choices.map((choice) =>
        item.form && choice.effect.startsWith("allow") ? (
          <button
            key={choice.id}
            type="submit"
            className="primary"
            onClick={focusComposer}
          >
            {choice.label}
          </button>
        ) : (
          <Chat.AskChoice
            key={choice.id}
            choice={choice}
            className={choice.effect.startsWith("allow") ? "primary" : undefined}
            onClick={focusComposer}
          >
            {choice.label}
          </Chat.AskChoice>
        ),
      )}
    </div>
  );
}

function AskCard({ item }: { readonly item: AskItem }) {
  const { items } = useChat();
  const prompt = items.find(
    (candidate): candidate is PromptItem =>
      candidate.kind === "prompt" && candidate.turnId === item.turnId,
  );
  const hostName = useHostName(prompt?.agent.hostId);
  return (
    <Chat.Ask item={item} className="card">
      <p className="card-what">{item.question}</p>
      {item.answer.state === "answered" ? (
        <p className="item-meta">Answered</p>
      ) : item.answer.state === "closed" ? (
        <p className="item-meta">No longer needed</p>
      ) : (
        <>
          {item.approval === "computer" ? (
            <p className="item-meta">{`Approve on ${hostName}`}</p>
          ) : null}
          {item.form ? (
            <Chat.AskForm className="ask-form">
              <AskActions item={item} />
            </Chat.AskForm>
          ) : (
            <AskActions item={item} />
          )}
        </>
      )}
    </Chat.Ask>
  );
}

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
          <PromptMeta item={item} />
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
      return <AskCard item={item} />;
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
