import {
  type AgentPrincipal,
  asId,
  type HostPrincipal,
  type TurnBinding,
} from "@parlor/core";
import { AuthFailure, type Delegation, type TurnDelegation } from "@parlor/server";
import { decodeProtectedHeader, errors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";

/** A host assertion's audience: signed by the computer's own key, per request. */
export const HOST_AUDIENCE = "parlor:host";
/** A turn token's audience: signed by the server, carried by the host's MCP proxy. */
export const TURN_AUDIENCE = "parlor:mcp";

export const HOST_ASSERTION_TYP = "parlor-host+jwt";
export const TURN_TOKEN_TYP = "parlor-turn+jwt";

/**
 * A turn token never outlives the revocation horizon, or a revoked grant's token could
 * verify after `RevocationSet` forgot the revocation.
 */
export const MAX_TURN_TOKEN_TTL_MS = 600_000;

const CLOCK_SKEW_MS = 60_000;

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

const JWS_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function brand<A extends TokenAudience>(compact: string): Jws<A> {
  return compact as Jws<A>;
}

function typOf(jws: string): string | undefined {
  try {
    return decodeProtectedHeader(jws).typ;
  } catch {
    throw new AuthFailure("invalid", "The token is malformed.");
  }
}

/** `ParlorHost <jws>` is a host; a `Bearer` JWS whose header says `typ: parlor-turn+jwt` is a turn. */
export function credentialOf(authorization: string | null): Credential | undefined {
  if (authorization === null) return undefined;
  const match = /^([A-Za-z]+)\s+(\S+)$/.exec(authorization);
  const scheme = match?.[1]?.toLowerCase();
  const value = match?.[2];
  if (value === undefined || (scheme !== "bearer" && scheme !== "parlorhost")) {
    throw new AuthFailure("invalid", "Use a Bearer token.");
  }
  if (scheme === "parlorhost") {
    if (!JWS_SHAPE.test(value)) {
      throw new AuthFailure("invalid", "The host assertion is malformed.");
    }
    return { kind: "host", assertion: brand<typeof HOST_AUDIENCE>(value) };
  }
  if (!JWS_SHAPE.test(value)) return { kind: "session", token: value };
  return typOf(value) === TURN_TOKEN_TYP
    ? { kind: "turn", token: brand<typeof TURN_AUDIENCE>(value) }
    : { kind: "access", token: value };
}

/** Mints a turn token for `host`'s grant; the provider's `delegate`. */
export async function delegate(
  keys: TurnTokenKeys,
  host: HostPrincipal,
  turn: TurnDelegation,
  now: number,
): Promise<Delegation> {
  if (!(turn.ttlMs > 0)) throw new RangeError("A turn token needs a positive lifetime.");
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.ceil(Math.min(turn.ttlMs, MAX_TURN_TOKEN_TTL_MS) / 1000);
  const claims: TurnTokenClaims = {
    aud: TURN_AUDIENCE,
    iss: keys.issuer,
    sub: host.userId,
    gid: host.grantId,
    hid: host.hostId,
    thr: turn.threadId,
    trn: turn.turnId,
    cid: turn.clientId,
    agt: turn.agent,
    iat,
    exp,
  };
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", typ: TURN_TOKEN_TYP, kid: keys.kid })
    .sign(keys.privateKey);
  return { token, expiresAt: exp * 1000 };
}

const claimsSchema = z.object({
  aud: z.literal(TURN_AUDIENCE),
  iss: z.string().min(1),
  sub: z.string().min(1),
  gid: z.string().min(1),
  hid: z.string().min(1),
  thr: z.string().min(1),
  trn: z.string().min(1),
  cid: z.string(),
  agt: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});

/** Signature, `aud`, `iss` and `exp` only; the caller then asks `RevocationSet` about `gid`. */
export async function verifyTurnToken(
  keys: TurnTokenKeys,
  token: TurnToken,
  now: number,
): Promise<TurnTokenClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(
      token,
      (header) => {
        const key =
          header.kid === undefined ? undefined : keys.publicKeys.get(header.kid);
        if (!key) throw new errors.JWKSNoMatchingKey();
        return key;
      },
      {
        algorithms: ["ES256"],
        typ: TURN_TOKEN_TYP,
        issuer: keys.issuer,
        audience: TURN_AUDIENCE,
        currentDate: new Date(now),
      },
    ));
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new AuthFailure("expired", "The turn token expired.");
    }
    throw new AuthFailure("invalid", "The turn token is invalid.");
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new AuthFailure("invalid", "The turn token is malformed.");
  const { iat, exp } = claims.data;
  if (exp - iat > MAX_TURN_TOKEN_TTL_MS / 1000 || iat * 1000 > now + CLOCK_SKEW_MS) {
    throw new AuthFailure("invalid", "The turn token has an impossible lifetime.");
  }
  return claims.data;
}

export function agentPrincipalOf(
  claims: TurnTokenClaims,
): AgentPrincipal & { readonly turn: TurnBinding } {
  return {
    kind: "agent",
    userId: asId("user", claims.sub),
    grantId: asId("grant", claims.gid),
    agent: { name: claims.agt, verified: true },
    turn: {
      threadId: asId("thread", claims.thr),
      turnId: asId("turn", claims.trn),
      hostId: asId("host", claims.hid),
      clientId: claims.cid,
    },
  };
}
