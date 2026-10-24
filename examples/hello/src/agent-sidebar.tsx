import { isPromptTooLong, PROMPT_LIMIT_MESSAGE, type TurnState } from "@parlor/chat";
import {
  type AgentConfirmation,
  Chat,
  type ChatItem,
  useChat,
  useLinkDevice,
  useSession,
} from "@parlor/client/react";
import { useEffect, useState } from "react";
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
      <LinkADevice />
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
      <LinkCard />
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
    </div>
  );
}

const formatCode = (code: string) => code.replace(/^(.{4})(.{4})(.{2})$/, "$1-$2-$3");

function useExpired(expiresAt: string | undefined): boolean {
  const [expiredAt, setExpiredAt] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== undefined && expiredAt === expiresAt;
}

function LinkCard() {
  const { link, startLink } = useChat();
  const expired = useExpired(link.status === "unlinked" ? link.expiresAt : undefined);
  if (link.status !== "unlinked") return null;
  if (link.code === undefined || expired) {
    return (
      <section
        className="sidebar-note"
        aria-label="Link this device"
        data-state="unlinked"
      >
        <p className="sidebar-note-title">Link this device</p>
        <p>
          To use your agents on {link.hostName} from this device, link it once, the way
          you link WhatsApp to a new device.
        </p>
        {expired ? <p>That code expired. Show a new one.</p> : null}
        {link.error ? (
          <p className="problem" role="alert">
            {link.error}
          </p>
        ) : null}
        <button
          type="button"
          className="primary"
          onClick={() => void startLink()}
          disabled={link.busy}
        >
          Continue with Face ID or Touch ID
        </button>
        {link.error ? (
          <button
            type="button"
            onClick={() => void startLink({ presence: false })}
            disabled={link.busy}
          >
            Link without it
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <section className="sidebar-note" aria-label="Link this device" data-state="linking">
      <p className="sidebar-note-title">Link this device</p>
      <p>
        On a device you already use, open the Agent sidebar, choose Link a device, and
        type:
      </p>
      <p className="link-code" data-testid="link-code">
        {formatCode(link.code)}
      </p>
      <p>No linked device with you? On {link.hostName}, run:</p>
      <code className="connect-command">
        npx @parlor/agent-host link {globalThis.location?.origin} {link.code}
      </code>
      <p>The code works for 15 minutes.</p>
    </section>
  );
}

function LinkADevice() {
  const { available, state, check, confirm, reset } = useLinkDevice();
  const { agents, link } = useChat();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  if (!available || agents.length === 0 || link.status !== "linked") return null;
  const computer = agents[0]!.hostName;
  const account = session.status === "signed-in" ? session.user.email : "your account";
  const close = () => {
    reset();
    setCode("");
    setOpen(false);
  };
  if (!open) {
    return (
      <button type="button" className="link-a-device" onClick={() => setOpen(true)}>
        Link a device
      </button>
    );
  }
  return (
    <section className="sidebar-note" aria-label="Link a device">
      {state.step === "confirm" ? (
        <>
          <p className="sidebar-note-title">Link {state.device.name}?</p>
          <p>
            It will be able to send requests to your agents on {computer}, signed in as{" "}
            {account}. Only link a device you have with you.
          </p>
          <button type="button" className="primary" onClick={() => void confirm()}>
            Link with Face ID or Touch ID
          </button>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </>
      ) : state.step === "linking" ? (
        <p>Confirm with Face ID or Touch ID…</p>
      ) : state.step === "linked" ? (
        <>
          <p className="sidebar-note-title">{state.name} is linked</p>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </>
      ) : state.step === "on-computer" ? (
        <>
          <p className="sidebar-note-title">
            Link {state.device.name} on {computer}
          </p>
          <p>This browser cannot confirm with Face ID or Touch ID. On {computer}, run:</p>
          <code className="connect-command">{state.command}</code>
          <button type="button" onClick={close}>
            Done
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void check(code);
          }}
        >
          <p className="sidebar-note-title">Link a device</p>
          <input
            name="link-code"
            aria-label="The code the new device shows"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="K7M4-PX2Q-8R"
          />
          {state.step === "error" ? (
            <p className="problem" role="alert">
              {state.message}
            </p>
          ) : null}
          <button
            type="submit"
            className="primary"
            disabled={code.trim() === "" || state.step === "checking"}
          >
            {state.step === "checking" ? "Checking…" : "Link"}
          </button>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </form>
      )}
    </section>
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
  const { error, draft } = useChat();
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
        <Chat.Status className="composer-status" />
        <Chat.Stop>Stop</Chat.Stop>
        <Chat.Send className="primary">Send</Chat.Send>
      </div>
    </Chat.Composer>
  );
}

const TURN_STATE: Partial<Record<TurnState, string>> = {
  queued: "Queued",
  cancelled: "Stopped",
  failed: "Failed",
};

type PromptItem = Extract<ChatItem<AgentConfirmation>, { kind: "prompt" }>;
type AskItem = Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>;

function useHostName(hostId: string | undefined): string {
  const { hosts } = useChat();
  return hosts.find((host) => host.id === hostId)?.name ?? "your computer";
}

function PromptMeta({ item }: { readonly item: PromptItem }) {
  const { resend } = useChat();
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
  const actions = item.form ? (
    <Chat.AskForm className="ask-form">
      <AskActions item={item} />
    </Chat.AskForm>
  ) : (
    <AskActions item={item} />
  );
  return (
    <Chat.Ask item={item} className="card">
      <p className="card-what">{item.question}</p>
      {item.answer.state === "answered" ? (
        <>
          <p className="item-meta">Answered</p>
          {item.approval === "computer" ? actions : null}
        </>
      ) : item.answer.state === "closed" ? (
        <p className="item-meta">No longer needed</p>
      ) : (
        <>
          {item.approval === "computer" ? (
            <p className="item-meta">{`Approve on ${hostName}`}</p>
          ) : null}
          {actions}
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
      if (item.event === "device_pending") return null;
      return (
        <p className="event">
          {EVENTS[item.event]}
          {item.detail ? `: ${item.detail}` : ""}
        </p>
      );
  }
}
