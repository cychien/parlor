import type {
  AuthenticatedPrincipal,
  DeviceId,
  GrantId,
  HostPrincipal,
  Principal,
  ThreadId,
  TurnId,
  UserId,
} from "@parlor/core";

import type { ServerPlugin } from "./plugin.js";

/**
 * Where identity comes from. The server calls `authenticate` once per request and hands
 * the principal to actions, MCP, sync and agent UI. It installs like any plugin, first.
 */
export interface AuthProvider extends ServerPlugin {
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
  /**
   * Mints the turn token an inline agent's MCP calls carry while one chat turn runs,
   * bound to the host's grant. Optional so providers written before chat still compile;
   * `chat()` refuses to start on a provider without it.
   */
  delegate?(host: HostPrincipal, turn: TurnDelegation): Promise<Delegation>;
  /**
   * Mints the token an agent on the host's computer carries outside any turn, such as
   * Claude Code in a terminal: an external MCP client of the user, revoked with the grant.
   */
  delegateAgent?(host: HostPrincipal, agent: AgentDelegation): Promise<Delegation>;
  /**
   * Whether the host grant still holds. Lists of computers drop a grant that answers
   * false at once, without waiting for the host to notice. Absent means every grant holds.
   */
  hostActive?(grantId: GrantId): Promise<boolean>;
  /** A device's public keys as the account registered them, for prompt and answer signatures. */
  device?(userId: UserId, deviceId: DeviceId): Promise<DeviceKeys | undefined>;
  /** Who the agent works for, for the turn's context block. */
  account?(userId: UserId): Promise<AccountProfile | undefined>;
}

/** Announced when a computer's grant is added or removed; whatever lists computers reads it. */
export const HOST_GRANTS_TAG = "parlor_auth_hosts";

export interface TurnDelegation {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly clientId: string;
  readonly agent: string;
  readonly ttlMs: number;
}

export interface AgentDelegation {
  /** How the app names it, such as "Claude Code on Alice's MacBook". */
  readonly agent: string;
  readonly ttlMs: number;
}

export interface Delegation {
  readonly token: string;
  readonly expiresAt: number;
}

export interface DeviceKeys {
  readonly id: DeviceId;
  readonly name: string;
  readonly platform: string;
  readonly signingKey: JsonWebKey;
  readonly presenceKey?: PresenceKey | undefined;
  /** Linked devices' signed word that this one is the user's; each computer checks them itself. */
  readonly vouches?: readonly DeviceVouch[] | undefined;
}

/** A `VouchStatement` as the voucher signed it, with its presence key. */
export interface DeviceVouch {
  readonly voucher: DeviceId;
  readonly commitment: string;
  readonly at: number;
  readonly signature: {
    readonly keyId: string;
    readonly presence: "none" | "user";
    readonly format: "es256-raw" | "webauthn";
    readonly signature: string;
    readonly authenticatorData?: string | undefined;
    readonly clientDataJSON?: string | undefined;
  };
}

export type PresenceKey =
  | {
      readonly format: "webauthn";
      readonly credentialId: string;
      readonly rpId: string;
      readonly publicKey: JsonWebKey;
    }
  | {
      readonly format: "es256-raw";
      readonly keyId: string;
      readonly publicKey: JsonWebKey;
    };

export interface AccountProfile {
  readonly name: string;
  readonly email?: string | undefined;
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
