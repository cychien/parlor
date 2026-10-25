import type { ParlorRouterContext } from "@parlor/client/router";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";

import { agentPanel } from "../agent/views.js";
import { withSignIn } from "../auth/sign-in-gate.js";
import { HeaderActions } from "../header-actions.js";

export const Route = createRootRouteWithContext<ParlorRouterContext>()({
  staticData: {
    description: "The app shell: a header with the agent button, then the page.",
    views: [agentPanel],
  },
  component: withSignIn(Layout),
});

function Layout() {
  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <Link to="/" className="font-semibold tracking-tight">
          Todos
        </Link>
        <HeaderActions />
      </header>
      <main className="mx-auto max-w-2xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
