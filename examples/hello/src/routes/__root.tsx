import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  staticData: { description: "The app shell: navigation to every page." },
  component: Layout,
});

const linkStyle = { color: "inherit", textDecoration: "none" };
const activeLinkStyle = { ...linkStyle, fontWeight: 600, textDecoration: "underline" };

function Layout() {
  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 480 }}>
      <nav aria-label="Main" style={{ display: "flex", gap: 16, marginBottom: 8 }}>
        <Link to="/" style={linkStyle} activeProps={{ style: activeLinkStyle }}>
          Tasks
        </Link>
        <Link to="/settings" style={linkStyle} activeProps={{ style: activeLinkStyle }}>
          Settings
        </Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
