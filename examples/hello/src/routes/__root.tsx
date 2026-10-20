import type { AgentActivityKind, AgentActivityState } from "@parlor/client/react";
import { Chat, useAgentConfirmations, useSession } from "@parlor/client/react";
import {
  createRootRoute,
  Link,
  Navigate,
  Outlet,
  useLocation,
} from "@tanstack/react-router";

import { AgentPanel } from "../agent-panel.js";
import { auth } from "../auth.js";
import { allCardsVisible, useSidebarView } from "../sidebar-view.js";
import { agentPanel } from "../views.js";

export const Route = createRootRoute({
  staticData: {
    description: "The app shell: navigation to every page.",
    views: [agentPanel],
  },
  component: Layout,
});

function Layout() {
  const session = useSession();
  const { pathname } = useLocation();
  if (pathname === "/sign-in") return <Outlet />;
  if (session.status === "loading") return null;
  if (session.status === "signed-out") return <Navigate to="/sign-in" replace />;
  return (
    <div className="shell">
      <nav aria-label="Main" className="topbar">
        <Link to="/">Tasks</Link>
        <Link to="/settings">Settings</Link>
        <div className="topbar-agent">
          <AgentIndicator />
          <AgentPanel />
        </div>
        {session.status === "signed-in" ? (
          <button type="button" className="link" onClick={() => void auth.signOut()}>
            Sign out
          </button>
        ) : null}
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
  const pending = useAgentConfirmations();
  const view = useSidebarView();
  return (
    <Chat.Activity className="agent-status" hidden={allCardsVisible(pending, view)}>
      {describe}
    </Chat.Activity>
  );
}
