import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ANONYMOUS,
  type AgentPrincipal,
  asId,
  DEV_USER_ID,
  type HostPrincipal,
  type Principal,
} from "@parlor/core";

import { AuthFailure, type AuthProvider, type TurnDelegation } from "./auth.js";

export const DEV_AUTH_PLUGIN = "dev-auth";

export { DEV_USER_ID };

/** `POST /_parlor/dev-auth/host`: mints the dev host token for a loopback caller. */
export const DEV_HOST_PATH = "/host";

export interface DevAuthOptions {
  readonly secret?: Uint8Array | undefined;
}

const HOST_TYP = "parlor-dev-host+jwt";
const TURN_TYP = "parlor-turn+jwt";
const HOST_AUDIENCE = "parlor:host";
const TURN_AUDIENCE = "parlor:mcp";
const DEV_GRANT = asId("grant", "dev");
const DEV_HOST = asId("host", "dev");

interface TurnClaims {
  readonly aud: typeof TURN_AUDIENCE;
  readonly sub: string;
  readonly hid: string;
  readonly thr: string;
  readonly trn: string;
  readonly cid: string;
  readonly agt: string;
  readonly iat: number;
  readonly exp: number;
}

type Fields = Readonly<Record<string, unknown>>;

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function decode(segment: string | undefined): Fields | undefined {
  if (!segment) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Fields) : undefined;
  } catch {
    return undefined;
  }
}

function isLoopback(ip: string | undefined): boolean {
  if (ip === undefined) return false;
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

const refuse = (message: string) =>
  Response.json({ error: { code: "forbidden", message } }, { status: 403 });

/**
 * What `parlor dev` installs when the app has no auth provider. Not enforcing, so the
 * browser and external MCP clients keep today's anonymous, header-declared behavior; it
 * only adds the host and turn tokens the local inline agent needs. Both are signed with a
 * per-process secret, so restarting the server revokes them all.
 */
export function devAuth(options: DevAuthOptions = {}): AuthProvider {
  const secret = options.secret ?? randomBytes(32);
  const mac = (input: string) =>
    createHmac("sha256", secret).update(input).digest("base64url");
  const sign = (typ: string, claims: object) => {
    const input = `${encode({ alg: "HS256", typ })}.${encode(claims)}`;
    return `${input}.${mac(input)}`;
  };
  const verify = (token: string, typ: string): Fields | undefined => {
    const [header, payload, signature, ...rest] = token.split(".");
    if (rest.length > 0 || !header || !payload || !signature) return undefined;
    const expected = Buffer.from(mac(`${header}.${payload}`));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    return decode(header)?.typ === typ ? decode(payload) : undefined;
  };
  const typOf = (token: string) => decode(token.split(".")[0])?.typ;

  const hostOf = (token: string): HostPrincipal => {
    if (verify(token, HOST_TYP)?.aud !== HOST_AUDIENCE) {
      throw new AuthFailure("invalid", "This computer is not connected.");
    }
    return { kind: "host", userId: DEV_USER_ID, grantId: DEV_GRANT, hostId: DEV_HOST };
  };

  const agentOf = (token: string): AgentPrincipal => {
    const claims = verify(token, TURN_TYP) as Partial<TurnClaims> | undefined;
    if (
      claims?.aud !== TURN_AUDIENCE ||
      typeof claims.exp !== "number" ||
      !claims.hid ||
      !claims.thr ||
      !claims.trn ||
      typeof claims.cid !== "string" ||
      !claims.agt
    ) {
      throw new AuthFailure("invalid", "The turn token is not valid.");
    }
    if (claims.exp * 1000 <= Date.now()) {
      throw new AuthFailure("expired", "The turn is over.");
    }
    return {
      kind: "agent",
      userId: DEV_USER_ID,
      grantId: DEV_GRANT,
      agent: { name: claims.agt, verified: true },
      turn: {
        threadId: asId("thread", claims.thr),
        turnId: asId("turn", claims.trn),
        hostId: asId("host", claims.hid),
        clientId: claims.cid,
      },
    };
  };

  return {
    name: DEV_AUTH_PLUGIN,
    enforcing: false,
    setup: () => ({
      routes: [
        {
          method: "POST",
          path: DEV_HOST_PATH,
          access: "public",
          handle: async (request) => {
            if (request.headers.has("origin")) {
              return refuse("The dev host token is not for web pages.");
            }
            if (!isLoopback((request as Request & { readonly ip?: string }).ip)) {
              return refuse("The dev host token is only for this computer.");
            }
            return Response.json({
              token: sign(HOST_TYP, { aud: HOST_AUDIENCE, hid: DEV_HOST }),
              hostId: DEV_HOST,
            });
          },
        },
      ],
    }),
    authenticate: async (request): Promise<Principal> => {
      const match = /^(\w+)\s+(\S+)$/.exec(request.headers.get("authorization") ?? "");
      const scheme = match?.[1]?.toLowerCase();
      const token = match?.[2];
      if (!token) return ANONYMOUS;
      if (scheme === "parlorhost") return hostOf(token);
      if (scheme === "bearer" && typOf(token) === TURN_TYP) return agentOf(token);
      return ANONYMOUS;
    },
    challenge: () =>
      Response.json(
        { error: { code: "unauthenticated", message: "The turn is over." } },
        { status: 401 },
      ),
    revoked: () => new AbortController().signal,
    delegate: async (host: HostPrincipal, turn: TurnDelegation) => {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + Math.ceil(turn.ttlMs / 1000);
      const claims: TurnClaims = {
        aud: TURN_AUDIENCE,
        sub: host.userId,
        hid: host.hostId,
        thr: turn.threadId,
        trn: turn.turnId,
        cid: turn.clientId,
        agt: turn.agent,
        iat,
        exp,
      };
      return { token: sign(TURN_TYP, claims), expiresAt: exp * 1000 };
    },
  };
}
