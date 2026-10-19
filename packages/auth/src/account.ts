import {
  ActionError,
  type ActionContext,
  defineAction,
  type UserPrincipal,
} from "@parlor/core";
import { type ActionsOf, createRegistry } from "@parlor/core/registry";
import type { PluginHost } from "@parlor/server";
import { z } from "zod";

import { grantIdOf } from "./grants.js";
import type { HostAccountActions } from "./hosts.js";
import type { BetterAuthInstance } from "./provider.js";
import type { RevocationNotice } from "./revocation.js";

export const SESSIONS_TAG = "parlor_auth_sessions";
export const AGENTS_TAG = "parlor_auth_agents";

export interface SignedInSession {
  readonly id: string;
  readonly current: boolean;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
}

export interface ConnectedAgent {
  readonly clientId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly connectedAt: string;
}

interface Grant {
  readonly clientId: string;
  readonly scopes: string | readonly string[];
  readonly createdAt: Date;
}

interface RefreshToken {
  readonly revoked?: Date | null;
  readonly expiresAt: Date;
}

export type AccountActions = ActionsOf<ReturnType<typeof accountActions>> &
  HostAccountActions;

interface AccountDeps {
  readonly instance: BetterAuthInstance;
  readonly host: PluginHost;
  readonly revoke: (notice: RevocationNotice) => Promise<void>;
}

export function signedIn(ctx: ActionContext): UserPrincipal {
  if (ctx.principal.kind !== "user") {
    throw new ActionError("forbidden", "Only a signed-in user manages the account.");
  }
  return ctx.principal;
}

const scopesOf = (scopes: Grant["scopes"]) =>
  typeof scopes === "string" ? scopes.split(" ").filter(Boolean) : [...scopes];

/**
 * Plugin actions at `/_parlor/auth/actions/<name>`. Better Auth writes through its own
 * connection, so these never run inside an action transaction (on PGlite that would
 * deadlock) and announce their changes afterwards instead of declaring `writes`.
 */
export function accountActions({ instance, host, revoke }: AccountDeps) {
  return createRegistry({
    sessions: defineAction({
      description: "List the places this account is signed in.",
      input: z.object({}),
      reads: [SESSIONS_TAG],
      run: async (_input, ctx): Promise<SignedInSession[]> => {
        const user = signedIn(ctx);
        const { internalAdapter } = await instance.$context;
        const sessions = await internalAdapter.listSessions(user.userId);
        return sessions
          .filter((session) => session.expiresAt.getTime() > Date.now())
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .map((session) => ({
            id: session.id,
            current: session.id === user.sessionId,
            userAgent: session.userAgent ?? null,
            ipAddress: session.ipAddress ?? null,
            createdAt: session.createdAt.toISOString(),
            lastActiveAt: session.updatedAt.toISOString(),
          }));
      },
    }),
    revokeSession: defineAction({
      description: "Sign this account out of one place; its open connections close.",
      input: z.object({ id: z.string().min(1) }),
      run: async ({ id }, ctx) => {
        const user = signedIn(ctx);
        const { internalAdapter } = await instance.$context;
        const sessions = await internalAdapter.listSessions(user.userId);
        const session = sessions.find((candidate) => candidate.id === id);
        if (!session) throw new ActionError("not_found", `No session ${id}`);
        await internalAdapter.deleteSession(session.token);
        await host.announce(ctx.scope, [[SESSIONS_TAG, id]]);
        return { id };
      },
    }),
    agents: defineAction({
      description: "List the agents this account authorized through MCP.",
      input: z.object({}),
      reads: [AGENTS_TAG],
      run: async (_input, ctx): Promise<ConnectedAgent[]> => {
        const user = signedIn(ctx);
        const { adapter } = await instance.$context;
        const mine = [{ field: "userId", value: user.userId }];
        const [consents, refreshTokens] = await Promise.all([
          adapter.findMany<Grant>({ model: "oauthConsent", where: mine }),
          adapter.findMany<Grant & RefreshToken>({
            model: "oauthRefreshToken",
            where: mine,
          }),
        ]);
        // A trusted client skips consent, so its live refresh tokens are its only trace.
        const live = refreshTokens.filter(
          (token) => !token.revoked && token.expiresAt.getTime() > Date.now(),
        );
        const grants = new Map<string, Grant>();
        for (const grant of [...live, ...consents]) {
          const known = grants.get(grant.clientId);
          if (!known || grant.createdAt < known.createdAt)
            grants.set(grant.clientId, grant);
        }
        return Promise.all(
          [...grants.values()].map(async (grant) => {
            const client = await adapter.findOne<{ name?: string | null }>({
              model: "oauthClient",
              where: [{ field: "clientId", value: grant.clientId }],
            });
            return {
              clientId: grant.clientId,
              name: client?.name || grant.clientId,
              scopes: scopesOf(grant.scopes),
              connectedAt: grant.createdAt.toISOString(),
            };
          }),
        );
      },
    }),
    revokeAgent: defineAction({
      description: "Revoke an agent's access; its tokens stop working at once.",
      input: z.object({ clientId: z.string().min(1) }),
      run: async ({ clientId }, ctx) => {
        const user = signedIn(ctx);
        await revoke({ kind: "grant", id: grantIdOf(user.userId, clientId) });
        const { adapter } = await instance.$context;
        const where = [
          { field: "userId", value: user.userId },
          { field: "clientId", value: clientId },
        ];
        for (const model of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"]) {
          await adapter.deleteMany({ model, where });
        }
        await host.announce(ctx.scope, [[AGENTS_TAG, clientId]]);
        return { id: clientId };
      },
    }),
  });
}
