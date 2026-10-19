import {
  type AgentPrincipal,
  ANONYMOUS,
  asId,
  type AuthenticatedPrincipal,
  type Principal,
  type UserPrincipal,
} from "@parlor/core";
import { AuthFailure, type AuthProvider, type PluginHost } from "@parlor/server";
import type { BetterAuthOptions } from "better-auth";
import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  jwtVerify,
} from "jose";

import { accountActions } from "./account.js";
import {
  ACCESS_TOKEN_TTL_S,
  AUTH_PLUGIN,
  bridgeOf,
  MCP_SCOPE,
  type ParlorAuthSettings,
} from "./better-auth.js";
import { grantIdOf } from "./grants.js";
import { AUTH_MIGRATIONS } from "./migrations.js";
import { RevocationSet } from "./revocation.js";
import { authRoutes } from "./routes.js";

/** The slice of a Better Auth instance Parlor relies on. */
export interface BetterAuthInstance {
  readonly options: BetterAuthOptions;
  handler(request: Request): Promise<Response>;
  readonly api: {
    getSession(input: { headers: Headers }): Promise<{
      readonly session: { readonly id: string; readonly userId: string };
      readonly user: {
        readonly id: string;
        readonly name: string;
        readonly email: string;
      };
    } | null>;
  };
  readonly $context: Promise<BetterAuthContext>;
}

interface Where {
  readonly field: string;
  readonly value: string;
}

export interface BetterAuthContext {
  readonly authCookies: { readonly sessionToken: { readonly name: string } };
  readonly adapter: {
    findMany<T>(input: { model: string; where?: Where[] }): Promise<T[]>;
    findOne<T>(input: { model: string; where: Where[] }): Promise<T | null>;
    deleteMany(input: { model: string; where: Where[] }): Promise<number>;
  };
  readonly internalAdapter: {
    listSessions(userId: string): Promise<StoredSession[]>;
    deleteSession(token: string): Promise<void>;
  };
}

export interface StoredSession {
  readonly id: string;
  readonly token: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

export interface BetterAuthProviderOptions {
  readonly instance: BetterAuthInstance;
}

/** Clock skew a revocation must outlast beyond the access token's own lifetime. */
const SKEW_MS = 60_000;

const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new AuthFailure("invalid", "Use a Bearer token.");
  return match[1]!;
}

function hasCookie(request: Request, name: string): boolean {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;
  return cookie.split(";").some((part) => part.trim().startsWith(`${name}=`));
}

/**
 * Sessions become user principals: a cookie on the same-origin web, a bearer token in
 * native shells. Access tokens Better Auth issued to MCP clients become agent principals
 * without a turn.
 */
export function betterAuthProvider({
  instance,
}: BetterAuthProviderOptions): AuthProvider {
  const bridge = bridgeOf(instance.options);
  const settings: ParlorAuthSettings = bridge.settings;
  let revocations: RevocationSet | undefined;
  let keys: ReturnType<typeof createLocalJWKSet> | undefined;
  const clientNames = new Map<string, Promise<string>>();

  const started = () => {
    if (!revocations) throw new Error("The auth provider is not installed.");
    return revocations;
  };

  const loadKeys = async () => {
    const response = await instance.handler(new Request(`${settings.baseURL}/jwks`));
    if (!response.ok)
      throw new Error(`Better Auth answered /jwks with ${response.status}`);
    return createLocalJWKSet((await response.json()) as JSONWebKeySet);
  };

  const verify = async (token: string): Promise<JWTPayload> => {
    const options = {
      issuer: settings.baseURL,
      audience: settings.resource,
      typ: "at+jwt",
    };
    keys ??= await loadKeys();
    try {
      return (await jwtVerify(token, keys, options)).payload;
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
      keys = await loadKeys();
      return (await jwtVerify(token, keys, options)).payload;
    }
  };

  const clientName = (clientId: string): Promise<string> => {
    let name = clientNames.get(clientId);
    if (!name) {
      name = instance.$context
        .then((context) =>
          context.adapter.findOne<{ name?: string | null }>({
            model: "oauthClient",
            where: [{ field: "clientId", value: clientId }],
          }),
        )
        .then((client) => client?.name || clientId);
      name.catch(() => clientNames.delete(clientId));
      clientNames.set(clientId, name);
    }
    return name;
  };

  const agentOf = async (token: string): Promise<AgentPrincipal> => {
    let payload: JWTPayload;
    try {
      payload = await verify(token);
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new AuthFailure("expired", "The access token expired.");
      }
      throw new AuthFailure("invalid", "The access token is invalid.");
    }
    const { sub, iat } = payload;
    const clientId = payload.client_id;
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (typeof sub !== "string" || typeof clientId !== "string" || iat === undefined) {
      throw new AuthFailure("invalid", "The access token is missing claims.");
    }
    if (!scopes.includes(MCP_SCOPE)) {
      throw new AuthFailure(
        "invalid",
        `The access token lacks the "${MCP_SCOPE}" scope.`,
      );
    }
    const grantId = grantIdOf(sub, clientId);
    if (await started().isRevoked({ kind: "grant", id: grantId }, iat * 1000)) {
      throw new AuthFailure("revoked", "Access for this agent was revoked.");
    }
    return {
      kind: "agent",
      userId: asId("user", sub),
      grantId,
      agent: {
        name: await clientName(clientId),
        verified: clientId.startsWith("https://"),
      },
    };
  };

  const userOf = async (request: Request): Promise<UserPrincipal | undefined> => {
    const found = await instance.api.getSession({ headers: request.headers });
    if (!found) return undefined;
    return {
      kind: "user",
      userId: asId("user", found.user.id),
      sessionId: found.session.id,
    };
  };

  return {
    name: AUTH_PLUGIN,
    migrations: AUTH_MIGRATIONS,
    enforcing: true,
    setup(host: PluginHost) {
      const { database } = host;
      if (!database) throw new Error("The auth plugin needs a database.");
      const set = new RevocationSet({
        database,
        horizonMs: ACCESS_TOKEN_TTL_S * 1000 + SKEW_MS,
      });
      revocations = set;
      bridge.revoke = (notice) =>
        database.transaction((tx) => RevocationSet.revoke(tx, notice));
      // TODO(phase 3): merge hostAccountActions, add hostRoutes, append HOSTS_MIGRATION,
      //   and answer delegate and account.
      return {
        actions: accountActions({ instance, host, revoke: bridge.revoke }),
        routes: authRoutes({ instance, settings, host }),
        close: () => set.stop(),
      };
    },
    async authenticate(request: Request): Promise<Principal> {
      await started().ready();
      // TODO(phase 3): credentialOf(header) first: `ParlorHost` -> verifyHostAssertion ->
      //   host principal; a turn token -> verifyTurnToken -> agentPrincipalOf; both then
      //   checked against RevocationSet by grant.
      const token = bearerOf(request);
      if (token !== undefined) {
        if (JWT.test(token)) return agentOf(token);
        const user = await userOf(request);
        if (!user)
          throw new AuthFailure("invalid", "The session is invalid or has ended.");
        return user;
      }
      const { authCookies } = await instance.$context;
      if (!hasCookie(request, authCookies.sessionToken.name)) return ANONYMOUS;
      return (await userOf(request)) ?? ANONYMOUS;
    },
    challenge(): Response {
      const metadata = `${settings.origin}/.well-known/oauth-protected-resource${new URL(settings.resource).pathname}`;
      return Response.json(
        { error: { code: "unauthenticated", message: "Sign in through OAuth first." } },
        {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPE}"`,
          },
        },
      );
    },
    revoked(principal: AuthenticatedPrincipal): AbortSignal {
      const notice =
        principal.kind === "user"
          ? ({ kind: "session", id: principal.sessionId } as const)
          : ({ kind: "grant", id: principal.grantId } as const);
      return started().signal([notice]);
    },
  };
}
