import type { AuthenticatedPrincipal, Principal } from "@parlor/core";

/**
 * Where identity comes from. The server calls `authenticate` once per request and hands
 * the principal to actions, MCP, sync and agent UI.
 */
export interface AuthProvider {
  /**
   * When true, an anonymous caller is refused by non-public actions, by MCP (with
   * `challenge`) and by `/ui`, and `x-parlor-source` no longer decides an action's source.
   */
  readonly enforcing: boolean;
  /**
   * Missing credentials resolve to `anonymous`. Present but invalid, expired or revoked
   * credentials throw `AuthFailure`, which every surface answers with 401.
   */
  authenticate(request: Request): Promise<Principal>;
  /** The 401 an MCP client reads to discover the authorization server (RFC 9728). */
  challenge(request: Request): Response;
  /**
   * Aborts when the session or grant behind the principal is revoked. Held connections
   * (sync streams) close on it.
   */
  revoked(principal: AuthenticatedPrincipal): AbortSignal;
}

export type AuthFailureReason = "invalid" | "expired" | "revoked";

export class AuthFailure extends Error {
  override readonly name = "AuthFailure";
  constructor(
    readonly reason: AuthFailureReason,
    message: string,
  ) {
    super(message);
  }
}
