import {
  type AgentPrincipal,
  ANONYMOUS,
  asId,
  type AuthenticatedPrincipal,
  type DeviceId,
  type GrantId,
  type HostPrincipal,
  type Principal,
  type UserId,
  type UserPrincipal,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import {
  type AccountProfile,
  AuthFailure,
  type AuthProvider,
  type Delegation,
  type DeviceKeys,
  type PluginHost,
  REVOCATION_HORIZON_MS,
  type TurnDelegation,
} from "@parlor/server";
import type { BetterAuthOptions } from "better-auth";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  jwtVerify,
} from "jose";

import { accountActions } from "./account.js";
import { AUDIT_MIGRATION, createAuditLog } from "./audit.js";
import {
  AUTH_PLUGIN,
  bridgeOf,
  MCP_SCOPE,
  type ParlorAuthSettings,
} from "./better-auth.js";
import {
  createDeviceRegistry,
  type DeviceRegistry,
  deviceAccountActions,
  DEVICE_LINKING_MIGRATION,
  DEVICES_MIGRATION,
} from "./devices.js";
import { grantIdOf } from "./grants.js";
import {
  createGrantKeys,
  type GrantKeys,
  hostAccountActions,
  hostPrincipalOf,
  HOSTS_MIGRATION,
  hostRoutes,
  verifyHostAssertion,
} from "./hosts.js";
import { AUTH_MIGRATIONS } from "./migrations.js";
import { RevocationSet } from "./revocation.js";
import { authRoutes } from "./routes.js";
import {
  agentPrincipalOf,
  credentialOf,
  delegate,
  type HostAssertion,
  type TurnToken,
  verifyTurnToken,
} from "./tokens.js";
import {
  createTurnKeyStore,
  TURN_KEYS_MIGRATION,
  type TurnKeyStore,
} from "./turn-keys.js";

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
  readonly secret: string;
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
  let grantKeys: GrantKeys | undefined;
  let turnKeys: TurnKeyStore | undefined;
  let devices: DeviceRegistry | undefined;
  const clientNames = new Map<string, Promise<string>>();
  const authenticatedAt = new WeakMap<object, number>();

  const installed = () => {
    if (!grantKeys || !turnKeys || !devices) {
      throw new Error("The auth provider is not installed.");
    }
    return { grantKeys, turnKeys, devices };
  };

  const started = () => {
    if (!revocations) throw new Error("The auth provider is not installed.");
    return revocations;
  };

  let preparingTurnKeys = false;
  const ready = async (): Promise<void> => {
    await started().ready();
    if (!preparingTurnKeys) {
      preparingTurnKeys = true;
      installed()
        .turnKeys.keys()
        .catch(() => {
          preparingTurnKeys = false;
        });
    }
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

  const publicUrlOf = (request: Request): string =>
    new URL(new URL(request.url).pathname, settings.origin).href;

  const hostOf = async (
    request: Request,
    assertion: HostAssertion,
  ): Promise<HostPrincipal> => {
    const grant = await verifyHostAssertion(
      assertion,
      { method: request.method, url: publicUrlOf(request) },
      installed().grantKeys,
      Date.now(),
    );
    if (await started().isRevoked({ kind: "grant", id: grant.grantId })) {
      throw new AuthFailure("revoked", "This computer was disconnected.");
    }
    return hostPrincipalOf(grant);
  };

  const turnOf = async (token: TurnToken): Promise<AgentPrincipal> => {
    const store = installed().turnKeys;
    let turnTokenKeys = await store.keys();
    const kid = decodeProtectedHeader(token).kid;
    if (kid !== undefined && !turnTokenKeys.publicKeys.has(kid)) {
      turnTokenKeys = await store.refresh();
    }
    const claims = await verifyTurnToken(turnTokenKeys, token, Date.now());
    if (await started().isRevoked({ kind: "grant", id: claims.gid })) {
      throw new AuthFailure("revoked", "This computer was disconnected.");
    }
    return agentPrincipalOf(claims);
  };

  const authenticateRequest = async (request: Request): Promise<Principal> => {
    await ready();
    const credential = credentialOf(request.headers.get("authorization"));
    switch (credential?.kind) {
      case "host":
        return hostOf(request, credential.assertion);
      case "turn":
        return turnOf(credential.token);
      case "access":
        return agentOf(credential.token);
      case "session": {
        const user = await userOf(request);
        if (!user)
          throw new AuthFailure("invalid", "The session is invalid or has ended.");
        return user;
      }
      case undefined:
        break;
    }
    const { authCookies } = await instance.$context;
    if (!hasCookie(request, authCookies.sessionToken.name)) return ANONYMOUS;
    return (await userOf(request)) ?? ANONYMOUS;
  };

  return {
    name: AUTH_PLUGIN,
    migrations: [
      ...AUTH_MIGRATIONS,
      HOSTS_MIGRATION,
      DEVICES_MIGRATION,
      TURN_KEYS_MIGRATION,
      AUDIT_MIGRATION,
      DEVICE_LINKING_MIGRATION,
    ],
    enforcing: true,
    setup(host: PluginHost) {
      const { database } = host;
      if (!database) throw new Error("The auth plugin needs a database.");
      const set = new RevocationSet({
        database,
        horizonMs: REVOCATION_HORIZON_MS,
      });
      revocations = set;
      const auditLog = createAuditLog(database);
      bridge.revoke = (notice) =>
        database.transaction((tx) => RevocationSet.revoke(tx, notice));
      grantKeys = createGrantKeys(database);
      devices = createDeviceRegistry(database);
      turnKeys = createTurnKeyStore({
        database,
        issuer: settings.baseURL,
        secret: async () => (await instance.$context).secret,
      });
      const hostDeps = {
        host,
        settings,
      };
      return {
        actions: createRegistry({
          ...accountActions({ instance, host, revoke: bridge.revoke }).actions,
          ...hostAccountActions(hostDeps).actions,
          ...deviceAccountActions({ host, registry: devices }).actions,
        }),
        routes: [...authRoutes({ instance, settings, host }), ...hostRoutes(hostDeps)],
        audit: (record) => auditLog.record(record),
        close: async () => {
          await Promise.all([set.stop(), auditLog.stop()]);
        },
      };
    },
    async authenticate(request: Request): Promise<Principal> {
      const startedAt = Date.now();
      const principal = await authenticateRequest(request);
      if (principal.kind !== "anonymous") authenticatedAt.set(principal, startedAt);
      return principal;
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
    async delegate(host: HostPrincipal, turn: TurnDelegation): Promise<Delegation> {
      await ready();
      return delegate(await installed().turnKeys.keys(), host, turn, Date.now());
    },
    async hostActive(grantId: GrantId): Promise<boolean> {
      const revoked = await started().isRevoked({ kind: "grant", id: grantId });
      return !revoked && (await installed().grantKeys.get(grantId)) !== undefined;
    },
    async device(userId: UserId, deviceId: DeviceId): Promise<DeviceKeys | undefined> {
      const registered = await installed().devices.get(userId, deviceId);
      if (!registered) return undefined;
      const { id, name, platform, signingKey, presenceKey, vouches } = registered;
      return {
        id,
        name,
        platform,
        signingKey,
        presenceKey,
        ...(vouches ? { vouches } : {}),
      };
    },
    async account(userId: UserId): Promise<AccountProfile | undefined> {
      const { adapter } = await instance.$context;
      const user = await adapter.findOne<{ name: string; email: string }>({
        model: "user",
        where: [{ field: "id", value: userId }],
      });
      return user ? { name: user.name, email: user.email } : undefined;
    },
    revoked(principal: AuthenticatedPrincipal): AbortSignal {
      const notice =
        principal.kind === "user"
          ? ({ kind: "session", id: principal.sessionId } as const)
          : ({ kind: "grant", id: principal.grantId } as const);
      return started().signal([notice], authenticatedAt.get(principal));
    },
  };
}
