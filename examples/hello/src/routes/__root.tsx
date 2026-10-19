import type { AgentActivityKind, AgentActivityState } from "@parlor/client/react";
import { Chat } from "@parlor/client/react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

import { AgentPanel } from "../agent-panel.js";
import { agentPanel } from "../views.js";

export const Route = createRootRoute({
  staticData: {
    description: "The app shell: navigation to every page.",
    views: [agentPanel],
  },
  component: Layout,
});

function Layout() {
  return (
    <div className="shell">
      <nav aria-label="Main" className="topbar">
        <Link to="/">Tasks</Link>
        <Link to="/settings">Settings</Link>
        <div className="topbar-agent">
          <AgentIndicator />
          <AgentPanel />
        </div>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

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

const REFUSED: Record<AgentActivityKind, string> = {
  screen: "Agent could not read this screen",
  navigate: "Agent could not open that page",
  set: "Agent could not fill in the form",
  highlight: "Agent could not point at that",
  confirm: "Agent got your answer",
};

function describe(state: AgentActivityState): string {
  switch (state.status) {
    case "idle":
      return "No agent activity";
    case "busy":
      return DOING[state.op];
    case "done":
      return DONE[state.op];
    case "refused":
      return REFUSED[state.op];
  }
}

function AgentIndicator() {
  return <Chat.Activity className="agent-status">{describe}</Chat.Activity>;
}
