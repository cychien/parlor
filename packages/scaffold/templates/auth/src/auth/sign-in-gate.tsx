import { useSession } from "@parlor/client/react";
import { Navigate, Outlet, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const SIGN_IN_PATH = "/sign-in";

/** Wraps the root layout: the sign-in page renders bare, everything else needs a session. */
export function withSignIn(Layout: () => ReactNode): () => ReactNode {
  return function SignedIn() {
    const session = useSession();
    const { pathname } = useLocation();
    if (pathname === SIGN_IN_PATH) return <Outlet />;
    if (session.status === "loading") return null;
    if (session.status === "signed-out") return <Navigate to={SIGN_IN_PATH} replace />;
    return <Layout />;
  };
}
