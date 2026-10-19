import type { DeviceId, GrantId, HostId, ThreadId, TurnId, UserId } from "./ids.js";

/**
 * Who is calling, resolved once per request from its credential by the server's auth
 * provider. Never built from a header: `x-parlor-source` and `x-parlor-client` are
 * routing hints at most.
 */
export type Principal =
  | AnonymousPrincipal
  | UserPrincipal
  | AgentPrincipal
  | HostPrincipal;

export type PrincipalKind = Principal["kind"];

export interface AnonymousPrincipal {
  readonly kind: "anonymous";
}

/** A person in the app's own UI: a session on one device. */
export interface UserPrincipal {
  readonly kind: "user";
  readonly userId: UserId;
  readonly sessionId: string;
  readonly deviceId?: DeviceId | undefined;
}

/**
 * An agent acting for a user. `turn` is set only for an inline agent inside a chat turn;
 * an external MCP client has none.
 */
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly userId: UserId;
  readonly grantId: GrantId;
  readonly agent: AgentIdentity;
  readonly turn?: TurnBinding | undefined;
}

/** A user's computer running Parlor Host, holding a grant for one app. */
export interface HostPrincipal {
  readonly kind: "host";
  readonly userId: UserId;
  readonly grantId: GrantId;
  readonly hostId: HostId;
}

/** `verified` is false when the name is the MCP client's self-declared `clientInfo.name`. */
export interface AgentIdentity {
  readonly name: string;
  readonly verified: boolean;
}

export interface TurnBinding {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly hostId: HostId;
  readonly clientId: string;
}

export type AuthenticatedPrincipal = Exclude<Principal, AnonymousPrincipal>;

export const ANONYMOUS: AnonymousPrincipal = { kind: "anonymous" };

export function isAuthenticated(
  principal: Principal,
): principal is AuthenticatedPrincipal {
  return principal.kind !== "anonymous";
}

export function userOf(principal: Principal | undefined): UserId | undefined {
  if (principal === undefined) return undefined;
  return principal.kind === "anonymous" ? undefined : principal.userId;
}
