import type { AgentPrincipal, HostPrincipal, TurnBinding } from "@parlor/core";
import type { Delegation, TurnDelegation } from "@parlor/server";

/** A host assertion's audience: signed by the computer's own key, per request. */
export const HOST_AUDIENCE = "parlor:host";
/** A turn token's audience: signed by the server, carried by the host's MCP proxy. */
export const TURN_AUDIENCE = "parlor:mcp";

export type TokenAudience = typeof HOST_AUDIENCE | typeof TURN_AUDIENCE;

declare const audience: unique symbol;

/** A compact JWS whose audience is known from the scheme it arrived under; never swapped. */
export type Jws<A extends TokenAudience> = string & { readonly [audience]: A };
export type HostAssertion = Jws<typeof HOST_AUDIENCE>;
export type TurnToken = Jws<typeof TURN_AUDIENCE>;

/** What an `authorization` header carries, sorted by scheme and shape before any verification. */
export type Credential =
  | { readonly kind: "host"; readonly assertion: HostAssertion }
  | { readonly kind: "turn"; readonly token: TurnToken }
  | { readonly kind: "access"; readonly token: string }
  | { readonly kind: "session"; readonly token: string };

export interface TurnTokenClaims {
  readonly aud: typeof TURN_AUDIENCE;
  readonly iss: string;
  /** user id */
  readonly sub: string;
  /** grant id: revoking the grant kills the token */
  readonly gid: string;
  readonly hid: string;
  readonly thr: string;
  readonly trn: string;
  /** the client the prompt came from; `ui_*` binds to it */
  readonly cid: string;
  readonly agt: string;
  readonly iat: number;
  /** as long as the turn's lease */
  readonly exp: number;
}

export interface TurnTokenKeys {
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKeys: ReadonlyMap<string, CryptoKey>;
}

/** `ParlorHost <jws>` is a host; a `Bearer` JWS whose header says `typ: parlor-turn+jwt` is a turn. */
export function credentialOf(authorization: string | null): Credential | undefined {
  // TODO: parse the scheme; ParlorHost -> host; Bearer + JWS with typ parlor-turn+jwt ->
  //   turn; Bearer + JWS typ at+jwt -> access; other Bearer -> session; malformed ->
  //   AuthFailure("invalid").
  void authorization;
  throw new Error("not implemented");
}

/** Mints a turn token for `host`'s grant; the provider's `delegate`. */
export async function delegate(
  keys: TurnTokenKeys,
  host: HostPrincipal,
  turn: TurnDelegation,
  now: number,
): Promise<Delegation> {
  // TODO: claims { aud: TURN_AUDIENCE, iss: keys.issuer, sub: host.userId, gid:
  //   host.grantId, hid: host.hostId, thr, trn, cid, agt, iat, exp: now + ttlMs }; ES256.
  void keys;
  void host;
  void turn;
  void now;
  throw new Error("not implemented");
}

/** Signature, `aud`, `iss` and `exp` only; the caller then asks `RevocationSet` about `gid`. */
export async function verifyTurnToken(
  keys: TurnTokenKeys,
  token: TurnToken,
  now: number,
): Promise<TurnTokenClaims> {
  void keys;
  void token;
  void now;
  throw new Error("not implemented");
}

export function agentPrincipalOf(
  claims: TurnTokenClaims,
): AgentPrincipal & { readonly turn: TurnBinding } {
  // TODO: { kind: "agent", userId: sub, grantId: gid, agent: { name: agt, verified: true },
  //   turn: { threadId: thr, turnId: trn, hostId: hid, clientId: cid } }, branded with asId.
  void claims;
  throw new Error("not implemented");
}
