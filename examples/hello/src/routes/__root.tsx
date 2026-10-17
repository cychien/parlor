import { type AgentActivity, useAgentActivity } from "@parlor/client/react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createRootRoute({
  staticData: { description: "The app shell: navigation to every page." },
  component: Layout,
});

const linkStyle = { color: "inherit", textDecoration: "none" };
const activeLinkStyle = { ...linkStyle, fontWeight: 600, textDecoration: "underline" };

function Layout() {
  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 480 }}>
      <nav
        aria-label="Main"
        style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}
      >
        <Link to="/" style={linkStyle} activeProps={{ style: activeLinkStyle }}>
          Tasks
        </Link>
        <Link to="/settings" style={linkStyle} activeProps={{ style: activeLinkStyle }}>
          Settings
        </Link>
        <AgentIndicator />
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

const LINGER_MS = 2000;

const DOING: Record<NonNullable<AgentActivity["last"]>["op"], string> = {
  screen: "Agent is reading this screen",
  navigate: "Agent is opening a page",
};
const DONE: Record<NonNullable<AgentActivity["last"]>["op"], string> = {
  screen: "Agent read this screen",
  navigate: "Agent opened this page",
};

function AgentIndicator() {
  const { busy, last } = useAgentActivity();
  const [faded, setFaded] = useState<number | undefined>();
  useEffect(() => {
    if (busy || !last) return;
    const timer = setTimeout(() => setFaded(last.at), LINGER_MS);
    return () => clearTimeout(timer);
  }, [busy, last]);
  const text = !last
    ? undefined
    : busy
      ? DOING[last.op]
      : faded === last.at
        ? undefined
        : DONE[last.op];
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        marginLeft: "auto",
        fontSize: 13,
        padding: "2px 10px",
        borderRadius: 999,
        background: "#eef2ff",
        color: "#3730a3",
        visibility: text ? "visible" : "hidden",
      }}
    >
      {text ?? "No agent activity"}
    </span>
  );
}
