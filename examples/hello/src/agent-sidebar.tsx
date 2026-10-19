import {
  type AgentConfirmation,
  Chat,
  type ChatItem,
  useChat,
} from "@parlor/client/react";

/** A usage sketch of the inline agent's chat; no route renders it yet. */
export default function AgentSidebar() {
  return (
    <Chat.Root>
      <AgentHeader />
      <Chat.Thread
        className="thread"
        empty={<p className="empty">Ask your agent to do something in Hello.</p>}
      >
        {(item) => <Item item={item} />}
      </Chat.Thread>
      <Chat.Composer className="composer">
        <Chat.Input placeholder="Message your agent" rows={2} />
        <Chat.Send>Send</Chat.Send>
        <Chat.Stop>Stop</Chat.Stop>
      </Chat.Composer>
    </Chat.Root>
  );
}

function AgentHeader() {
  const { agents, agent, choose, connect, status } = useChat();
  if (agents.length === 0) {
    return connect.kind === "here" ? (
      <button type="button" onClick={() => void connect.start()}>
        Use agents on this computer
      </button>
    ) : (
      <p>
        Connect a computer: <code>{connect.command}</code>
      </p>
    );
  }
  return (
    <header data-status={status}>
      <select
        aria-label="Agent"
        value={agent?.key ?? ""}
        onChange={(event) => choose(event.target.value)}
      >
        {agents.map((choice) => (
          <option
            key={choice.key}
            value={choice.key}
            disabled={!choice.online || !choice.ready}
          >
            {choice.name} on {choice.hostName}
          </option>
        ))}
      </select>
      {agent?.problem ? <p className="problem">{agent.problem}</p> : null}
    </header>
  );
}

function Item({ item }: { readonly item: ChatItem<AgentConfirmation> }) {
  switch (item.kind) {
    case "prompt":
      return <p className="prompt">{item.text}</p>;
    case "reply":
    case "reasoning":
      return <p className={item.kind}>{item.text}</p>;
    case "tool":
      return (
        <p className="tool" data-status={item.status}>
          {item.title}
        </p>
      );
    case "plan":
      return (
        <ul className="plan">
          {item.entries.map((entry) => (
            <li key={entry.content} data-status={entry.status}>
              {entry.content}
            </li>
          ))}
        </ul>
      );
    case "ask":
      return (
        <Chat.Ask item={item} className="card">
          <p>{item.question}</p>
          {item.approval === "computer" ? (
            <p>Answer on your computer.</p>
          ) : (
            item.choices.map((choice) => (
              <Chat.AskChoice key={choice.id} choice={choice}>
                {choice.label}
              </Chat.AskChoice>
            ))
          )}
        </Chat.Ask>
      );
    case "confirm":
      return (
        <Chat.Confirm confirmation={item.confirmation} className="card">
          <Chat.ConfirmLabel>
            {item.confirmation.origin.name ?? "Your agent"} wants to{" "}
            {item.confirmation.description}
          </Chat.ConfirmLabel>
          <div className="actions">
            <Chat.Approve className="primary">Approve</Chat.Approve>
            <Chat.Decline>Decline</Chat.Decline>
          </div>
        </Chat.Confirm>
      );
    case "event":
      return <p className="event">{item.event}</p>;
  }
}
