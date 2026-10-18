import {
  type AgentActivity,
  type AgentActivityKind,
  useAgentActivity,
} from "@parlor/client/react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ConfirmationCards } from "../confirmation-cards.js";

export const Route = createRootRoute({
  staticData: { description: "The app shell: navigation to every page." },
  component: Layout,
});

function Layout() {
  return (
    <div className="shell">
      <nav aria-label="Main" className="topbar">
        <Link to="/">Tasks</Link>
        <Link to="/settings">Settings</Link>
        <AgentIndicator />
      </nav>
      <ConfirmationCards />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

const LINGER_MS = 2000;

const DOING: Record<AgentActivityKind, string> = {
  screen: "Agent is reading this screen",
  navigate: "Agent is opening a page",
  set: "Agent is filling in a form",
  highlight: "Agent is pointing at something",
  confirm: "Agent is asking you to confirm",
};
const DONE: Record<AgentActivityKind, string> = {
  screen: "Agent read this screen",
  navigate: "Agent opened this page",
  set: "Agent filled in a form",
  highlight: "Agent pointed at something",
  confirm: "Agent got your answer",
};

function AgentIndicator() {
  const { busy, last } = useAgentActivity();
  const [faded, setFaded] = useState<AgentActivity["last"]>();
  useEffect(() => {
    if (busy || !last) return;
    const timer = setTimeout(() => setFaded(last), LINGER_MS);
    return () => clearTimeout(timer);
  }, [busy, last]);
  const text = !last
    ? undefined
    : busy
      ? DOING[last.op]
      : faded === last
        ? undefined
        : DONE[last.op];
  return (
    <span
      role="status"
      aria-live="polite"
      className="agent-status"
      data-idle={text ? undefined : ""}
    >
      {text ?? "No agent activity"}
    </span>
  );
}
