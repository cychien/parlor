import {
  asId,
  type DeviceId,
  type GrantId,
  type HostId,
  type KeyId,
  type ThreadId,
  type TurnId,
  type UserId,
} from "./ids.js";

/**
 * Who is calling, resolved once per request from its credential by the server's auth
 * provider. Never built from a header: `x-parlor-source` and `x-parlor-client` are
 * routing hints at most.
 */
export type Principal =
  | AnonymousPrincipal
  | UserPrincipal
  | AgentPrincipal
  | HostPrincipal
  | KeyPrincipal;

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

/**
 * A program holding an API key the app issued, bound to one scope. No person stands behind
 * its calls: it has no user, nobody can approve for it, and it reaches no screen.
 */
export interface KeyPrincipal {
  readonly kind: "key";
  readonly keyId: KeyId;
  /** The only scope it acts in; the server refuses a scope resolver that answers another. */
  readonly scope: string;
  /** How audit records and approvals name it, such as `API key "CI exporter"`. */
  readonly name: string;
  /** The app's own claims, such as a role. The framework never reads them. */
  readonly claims: Readonly<Record<string, string | boolean>>;
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

/** A signed-in principal backed by a user: everything but anonymous and a key. */
export type AuthenticatedPrincipal = UserPrincipal | AgentPrincipal | HostPrincipal;

export const ANONYMOUS: AnonymousPrincipal = { kind: "anonymous" };

/**
 * Who everyone is when no provider tells people apart: the anonymous browser and the
 * `parlor dev` host and turns. Equal to the default scope, so they share one audience.
 */
export const DEV_USER_ID: UserId = asId("user", "default");

export function hasUser(principal: Principal): principal is AuthenticatedPrincipal {
  return (
    principal.kind === "user" || principal.kind === "agent" || principal.kind === "host"
  );
}

/**
 * @deprecated Use `hasUser`, or `principal.kind !== "anonymous"` to include a key. Same as
 * `hasUser`: false for a key, which is signed in but has no user.
 */
export function isAuthenticated(
  principal: Principal,
): principal is AuthenticatedPrincipal {
  return hasUser(principal);
}

export function userOf(principal: Principal | undefined): UserId | undefined {
  return principal !== undefined && hasUser(principal) ? principal.userId : undefined;
}
