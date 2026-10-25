import { ActionError, type ActionErrorCode } from "@parlor/core";
import { type AnyRedirect, type NotFoundError, notFound } from "@tanstack/react-router";

/** For each `ActionError` code, the `redirect(...)` or `notFound(...)` a route throws instead. */
export type ActionErrorRoutes = {
  readonly [C in ActionErrorCode]?: (error: ActionError) => AnyRedirect | NotFoundError;
};

const DEFAULT_ROUTES: ActionErrorRoutes = { not_found: () => notFound() };

/**
 * Rethrows an `ActionError` as what `routes` names for its code, `not_found` as `notFound()`
 * unless `routes` says otherwise, and anything else unchanged for the route's `errorComponent`.
 * Pass it as a route's `onError`, or to `.catch` in a loader.
 */
export function routeActionErrors(
  routes: ActionErrorRoutes = {},
): (error: unknown) => never {
  const handlers = { ...DEFAULT_ROUTES, ...routes };
  return (error) => {
    const route = error instanceof ActionError ? handlers[error.code] : undefined;
    throw route ? route(error as ActionError) : error;
  };
}
