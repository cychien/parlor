import { routeActionErrors } from "@parlor/client/router";
import { redirect } from "@tanstack/react-router";

/** A missing record shows the route's not-found page; a signed-out caller goes to sign in. */
export const routeErrors = routeActionErrors({
  unauthenticated: () => redirect({ to: "/sign-in", replace: true }),
});
