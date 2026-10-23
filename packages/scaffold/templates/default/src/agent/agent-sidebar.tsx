import { isPromptTooLong, PROMPT_LIMIT_MESSAGE, type TurnState } from "@parlor/chat";
import {
  type AgentConfirmation,
  Chat,
  type ChatItem,
  useChat,
  useLinkDevice,
  useSession,
} from "@parlor/client/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";

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
          <LinkADevice />
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
        <LinkCard />
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
            <p>
              To chat with the AI agents on your computer, set it up once: run this in a
              terminal on it, then link this device.
            </p>
            <code data-testid="connect-command" className="block wrap-anywhere text-xs">
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

const NOTE = "mx-4 mb-4 space-y-2 rounded-lg border border-zinc-200 p-3 text-sm";

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

function LinkQr({ value }: { readonly value: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { border: 2 });
    const cells = qr.data.flatMap((row, y) =>
      row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])),
    );
    return { size: qr.size, path: cells.join("") };
  }, [value]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code to link this device"
      shapeRendering="crispEdges"
      className="mx-auto size-40 rounded bg-white"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

function LinkCard() {
  const { link, startLink } = useChat();
  const expired = useExpired(link.status === "unlinked" ? link.expiresAt : undefined);
  if (link.status !== "unlinked") return null;
  if (link.code === undefined || expired) {
    return (
      <section aria-label="Link this device" className={NOTE}>
        <p className="font-medium">Link this device</p>
        <p>
          To use your agents on {link.hostName} from this device, link it once, the way
          you link WhatsApp to a new device.
        </p>
        {expired ? <p className={META}>That code expired. Show a new one.</p> : null}
        {link.error ? (
          <p role="alert" className="text-xs text-red-600">
            {link.error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {link.error ? (
            <button
              type="button"
              onClick={() => void startLink({ presence: false })}
              disabled={link.busy}
              className={BUTTON}
            >
              Link without it
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void startLink()}
            disabled={link.busy}
            className={PRIMARY}
          >
            Continue with Face ID or Touch ID
          </button>
        </div>
        <p className={META}>
          Your messages and data stay in this app. Linking only lets this device send
          requests to the agents on your computer.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Link this device" className={NOTE}>
      <p className="font-medium">Link this device</p>
      <p>
        Scan this with a phone you already use with your agents, or on any device you
        already use open the Agent sidebar, choose Link a device, and type the code.
      </p>
      {link.qr ? <LinkQr value={link.qr} /> : null}
      <p
        data-testid="link-code"
        className="py-1 text-center font-mono text-2xl font-semibold tracking-widest"
      >
        {formatCode(link.code)}
      </p>
      <p className={META}>No linked device with you? On {link.hostName}, run:</p>
      <code className="block rounded bg-zinc-100 p-2 text-xs wrap-anywhere">
        npx @parlor/agent-host link {globalThis.location?.origin} {link.code}
      </code>
      <p className={META}>The code works for 15 minutes.</p>
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
      <button type="button" onClick={() => setOpen(true)} className={`${BUTTON} w-full`}>
        Link a device
      </button>
    );
  }
  return (
    <section
      aria-label="Link a device"
      className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm"
    >
      {state.step === "confirm" ? (
        <>
          <p className="font-medium">Link {state.device.name}?</p>
          <p>
            It will be able to send requests to your agents on {computer}, signed in as{" "}
            {account}. Only link a device you have with you.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className={BUTTON}>
              Cancel
            </button>
            <button type="button" onClick={() => void confirm()} className={PRIMARY}>
              Link with Face ID or Touch ID
            </button>
          </div>
        </>
      ) : state.step === "linking" ? (
        <p className={META}>Confirm with Face ID or Touch ID…</p>
      ) : state.step === "linked" ? (
        <>
          <p className="font-medium">{state.name} is linked</p>
          <p>It can use your agents now.</p>
          <div className="flex justify-end">
            <button type="button" onClick={close} className={PRIMARY}>
              Done
            </button>
          </div>
        </>
      ) : state.step === "on-computer" ? (
        <>
          <p className="font-medium">
            Link {state.device.name} on {computer}
          </p>
          <p>This browser cannot confirm with Face ID or Touch ID. On {computer}, run:</p>
          <code className="block rounded bg-zinc-100 p-2 text-xs wrap-anywhere">
            {state.command}
          </code>
          <div className="flex justify-end">
            <button type="button" onClick={close} className={BUTTON}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void check(code);
          }}
        >
          <p className="font-medium">Link a device</p>
          <label className="block space-y-1">
            <span className={META}>The code the new device shows</span>
            <input
              name="link-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="K7M4-PX2Q-8R"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm uppercase tracking-widest"
            />
          </label>
          {state.step === "error" ? (
            <p role="alert" className="text-xs text-red-600">
              {state.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className={BUTTON}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={code.trim() === "" || state.step === "checking"}
              className={PRIMARY}
            >
              {state.step === "checking" ? "Checking…" : "Link"}
            </button>
          </div>
        </form>
      )}
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
