import { type Principal, userOf } from "@parlor/core";

/** The tenant a request belongs to. Called once per request. */
export type ScopeResolver = (
  request: Request,
  principal: Principal,
) => string | Promise<string>;

export const DEFAULT_SCOPE = "default";

export const defaultScope: ScopeResolver = (_request, principal) =>
  userOf(principal) ?? DEFAULT_SCOPE;
