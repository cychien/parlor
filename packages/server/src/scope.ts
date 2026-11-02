import { type Principal, userOf } from "@parlor/core";

/**
 * The tenant a request belongs to. Called once per request. For a key it must answer the
 * key's own scope, or the request is refused.
 */
export type ScopeResolver = (
  request: Request,
  principal: Principal,
) => string | Promise<string>;

export const DEFAULT_SCOPE = "default";

export const defaultScope: ScopeResolver = (_request, principal) =>
  principal.kind === "key" ? principal.scope : (userOf(principal) ?? DEFAULT_SCOPE);
