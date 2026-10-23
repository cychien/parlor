import { isPromptTooLong, PROMPT_LIMIT_MESSAGE, type TurnState } from "@parlor/chat";
import {
  type AgentConfirmation,
  Chat,
  type ChatItem,
  useChat,
  useDeviceSetup,
} from "@parlor/client/react";
import { type ReactNode, useEffect } from "react";

import { ConfirmationCard, focusComposer } from "./confirmation-card.js";
import { sidebarView } from "./sidebar-view.js";

const DISABLED = "disabled:cursor-not-allowed disabled:opacity-40";
const BUTTON = `rounded-md border border-zinc-300 px-3 py-1 text-sm enabled:hover:bg-zinc-100 ${DISABLED}`;
const PRIMARY = `rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white ${DISABLED}`;
const META = "text-xs text-zinc-500";

export default function AgentSidebar() {
  return (
    <Chat.Root>
      <div className="flex min-h-0 flex-1 flex-col">
        <PublishThread />
        <div className="space-y-2 border-b border-zinc-200 p-4">
          <Computers />
          <Threads />
        </div>
        <Chat.Confirmations className="space-y-2 px-4 pt-4 empty:hidden">
          {(confirmation) =>
            confirmation.threadId === undefined ? (
              <ConfirmationCard confirmation={confirmation} />
            ) : null
          }
        </Chat.Confirmations>
        <Chat.Thread
          className="flex-1 space-y-3 overflow-y-auto p-4"
          empty={<ThreadEmpty />}
        >
          {(item) => <Item item={item} />}
        </Chat.Thread>
        <DeviceSetupCard />
        <Composer />
      </div>
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

function Threads() {
  const { threads, thread, openThread, newThread } = useChat();
  if (threads.length === 0) return null;
  return (
    <div className="flex gap-2">
      <select
        name="thread"
        aria-label="Conversation"
        value={thread?.id ?? ""}
        onChange={(event) => openThread(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-sm"
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
      <button
        type="button"
        disabled={thread === undefined}
        onClick={newThread}
        className={BUTTON}
      >
        New chat
      </button>
    </div>
  );
}

function Note({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1 rounded-lg bg-zinc-100 p-3 text-sm">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

function Computers() {
  const { agents, agent, choose, connect, hosts, status } = useChat();
  if (status === "loading") return null;
  if (status === "unavailable") {
    return (
      <Note title="The agent is not available here">
        <p>
          It runs with <code>parlor dev</code>. In production it needs sign-in: add it
          with <code>parlor add auth</code>.
        </p>
      </Note>
    );
  }
  if (agents.length === 0) {
    return (
      <Note title={hosts.length === 0 ? "No computer connected" : "No agent ready"}>
        {hosts.length > 0 ? (
          <p>None of your connected computers has an agent set up.</p>
        ) : connect.kind === "here" ? (
          <button type="button" onClick={() => void connect.start()} className={PRIMARY}>
            Use agents on this computer
          </button>
        ) : (
          <>
            <p>Run this in a terminal on your computer to chat with its agents here:</p>
            <code data-testid="connect-command" className="block break-all text-xs">
              {connect.command}
            </code>
          </>
        )}
      </Note>
    );
  }
  return (
    <div className="space-y-1">
      <select
        name="agent"
        aria-label="Agent"
        value={agent?.key ?? ""}
        onChange={(event) => choose(event.target.value)}
        className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
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
      {agent?.problem ? <p className="text-xs text-red-600">{agent.problem}</p> : null}
    </div>
  );
}

function ThreadEmpty() {
  const { status, agents } = useChat();
  const className = `px-4 pb-3 ${META}`;
  if (status === "loading") return <p className={className}>Loading...</p>;
  return (
    <p className={className}>
      {agents.length === 0
        ? "Your conversation with an agent shows up here."
        : "Ask your agent to do something in this app, like adding a todo."}
    </p>
  );
}

function DeviceSetupCard() {
  const { agent } = useChat();
  const { setup, setUpDevice, dismissSetup } = useDeviceSetup();
  if (!setup) return null;
  const computer = agent?.hostName ?? "your computer";
  const site = globalThis.location?.hostname ?? "this app";
  const busy = setup.step === "passkey";
  return (
    <section
      aria-label="Set up this browser"
      className="mx-4 mb-4 space-y-2 rounded-lg border border-zinc-200 p-3 text-sm"
    >
      {setup.step === "cancelled" ? (
        <>
          <p className="font-medium">The passkey was not created</p>
          <p>
            Try again, or continue without one. Your agent's permission questions are then
            answered on {computer}.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">Set up this browser</p>
          <p>Before your first message, two things happen once:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Your browser asks to create a passkey for {site}, so you can approve your
              agent's actions with Touch ID or your device's lock.
            </li>
            <li>{computer} asks you to allow this browser.</li>
          </ul>
          <p className={META}>
            Without a passkey, you answer your agent's permission questions on {computer}.
          </p>
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" onClick={dismissSetup} disabled={busy} className={BUTTON}>
          Not now
        </button>
        <button
          type="button"
          onClick={() => void setUpDevice({ passkey: false })}
          disabled={busy}
          className={BUTTON}
        >
          Skip passkey
        </button>
        <button
          type="button"
          onClick={() => void setUpDevice({ passkey: true })}
          disabled={busy}
          className={PRIMARY}
        >
          {setup.step === "cancelled" ? "Try again" : "Continue"}
        </button>
      </div>
    </section>
  );
}

function Composer() {
  const { error, draft } = useChat();
  const problem = isPromptTooLong(draft) ? PROMPT_LIMIT_MESSAGE : error;
  return (
    <Chat.Composer className="space-y-2 border-t border-zinc-200 p-4">
      <Chat.Input
        name="message"
        aria-label="Message"
        placeholder="Message your agent"
        rows={2}
        className="w-full resize-none rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
      />
      {problem ? (
        <p role="alert" className="text-xs text-red-600">
          {problem}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Chat.Status className={`min-w-0 flex-1 truncate ${META}`} />
        <Chat.Stop className={BUTTON}>Stop</Chat.Stop>
        <Chat.Send className={PRIMARY}>Send</Chat.Send>
      </div>
    </Chat.Composer>
  );
}

const TURN_STATE: Partial<Record<TurnState, string>> = {
  queued: "Queued",
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
  device_rejected: "This device was not approved",
  agent_started: "Agent started",
  agent_exited: "Agent exited",
  agent_switched: "Switched agent",
  host_lost: "Lost contact with the computer",
  turn_failed: "The turn failed",
  answer_rejected: "Your answer was not accepted",
} as const;

type PromptItem = Extract<ChatItem<AgentConfirmation>, { kind: "prompt" }>;
type AskItem = Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>;

function PromptMeta({ item }: { readonly item: PromptItem }) {
  const { resend, hosts } = useChat();
  if (item.failure === "prompt_expired") {
    const hostName = hosts.find((host) => host.id === item.agent.hostId)?.name;
    return (
      <div className="flex items-center gap-2">
        <p
          className={META}
        >{`Expired before ${hostName ?? "your computer"} picked it up`}</p>
        <button type="button" onClick={() => void resend(item.id)} className={BUTTON}>
          Resend
        </button>
      </div>
    );
  }
  const text = TURN_STATE[item.state];
  return text ? <p className={META}>{text}</p> : null;
}

function AskCard({ item }: { readonly item: AskItem }) {
  const choices = (
    <div className="flex flex-wrap gap-2">
      {item.choices.map((choice) =>
        item.form && choice.effect.startsWith("allow") ? (
          <button
            key={choice.id}
            type="submit"
            onClick={focusComposer}
            className={PRIMARY}
          >
            {choice.label}
          </button>
        ) : (
          <Chat.AskChoice
            key={choice.id}
            choice={choice}
            onClick={focusComposer}
            className={choice.effect.startsWith("allow") ? PRIMARY : BUTTON}
          >
            {choice.label}
          </Chat.AskChoice>
        ),
      )}
    </div>
  );
  return (
    <Chat.Ask
      item={item}
      className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm"
    >
      <p>{item.question}</p>
      {item.answer.state === "answered" ? (
        <p className={META}>Answered</p>
      ) : item.answer.state === "closed" ? (
        <p className={META}>No longer needed</p>
      ) : item.form ? (
        <Chat.AskForm className="space-y-2">{choices}</Chat.AskForm>
      ) : (
        choices
      )}
    </Chat.Ask>
  );
}

function Item({ item }: { readonly item: ChatItem<AgentConfirmation> }) {
  switch (item.kind) {
    case "prompt":
      return (
        <div className="ml-8 space-y-1">
          <p className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white">
            {item.text}
          </p>
          <PromptMeta item={item} />
        </div>
      );
    case "reply":
      return (
        <div className="space-y-1">
          <p className="whitespace-pre-wrap text-sm">{item.text}</p>
          {item.interrupted ? <p className={META}>Interrupted</p> : null}
        </div>
      );
    case "reasoning":
      return <p className="text-xs italic text-zinc-500">{item.text}</p>;
    case "tool":
      return (
        <p className="flex gap-2 text-xs" data-status={item.status}>
          <span className="font-mono">{item.title}</span>
          <span className="text-zinc-500">{TOOL_STATE[item.status]}</span>
        </p>
      );
    case "plan":
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm">
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
        <p className={META}>
          {EVENTS[item.event]}
          {item.detail ? `: ${item.detail}` : ""}
        </p>
      );
  }
}
