import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { DEFAULT_BASE_PATH, SHELL_ORIGINS } from "@parlor/server";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { bearer, jwt } from "better-auth/plugins";

import type { RevocationNotice } from "./revocation.js";

export const AUTH_PLUGIN = "auth";
export const AUTH_BASE_PATH = `${DEFAULT_BASE_PATH}/${AUTH_PLUGIN}`;
export const MCP_SCOPE = "mcp";
export const CONSENT_PATH = "/consent";
export const ACCESS_TOKEN_TTL_S = 600;

/** Better Auth endpoints that would let a user bypass Parlor's own account actions. */
const DISABLED_PATHS = [
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/get-clients",
  "/oauth2/delete-consent",
  "/oauth2/update-consent",
];

export interface ParlorAuthOptions extends Omit<
  BetterAuthOptions,
  "basePath" | "baseURL"
> {
  /**
   * The app's public origin, which serves its pages and `/_parlor`. Defaults to
   * `PARLOR_ORIGIN`, then to the web origin `parlor dev` sets.
   */
  readonly origin?: string | undefined;
  /**
   * The app page that signs a user in. An MCP client's authorization lands there and
   * resumes once the user signs in through `@parlor/auth/client`.
   */
  readonly signInPage: string;
}

export interface ParlorAuthSettings {
  readonly origin: string;
  readonly baseURL: string;
  readonly resource: string;
}

interface Bridge {
  settings: ParlorAuthSettings;
  revoke?: ((notice: RevocationNotice) => Promise<void>) | undefined;
}

const BRIDGE_PLUGIN = "parlor";

interface BridgePlugin extends BetterAuthPlugin {
  readonly bridge: Bridge;
}

function bridgePlugin(bridge: Bridge): BridgePlugin {
  const ended = async (notice: RevocationNotice) => {
    if (!bridge.revoke) {
      throw new Error("Install betterAuthProvider() in createServer({ auth }).");
    }
    await bridge.revoke(notice);
  };
  return {
    id: BRIDGE_PLUGIN,
    bridge,
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            delete: { after: (session) => ended({ kind: "session", id: session.id }) },
          },
        },
      },
    }),
  };
}

export function bridgeOf(options: BetterAuthOptions): Bridge {
  const plugin = options.plugins?.find((candidate) => candidate.id === BRIDGE_PLUGIN);
  if (!plugin) {
    throw new Error(
      "Pass the Better Auth options through parlorAuth() before betterAuth().",
    );
  }
  return (plugin as BridgePlugin).bridge;
}

function originOf(options: ParlorAuthOptions): string {
  const origin =
    options.origin ?? process.env.PARLOR_ORIGIN ?? process.env.PARLOR_WEB_ORIGIN;
  if (!origin) {
    throw new Error("Set PARLOR_ORIGIN to the app's public origin, or pass `origin`.");
  }
  return new URL(origin).origin;
}

/**
 * The Better Auth options Parlor needs, merged into the app's own: sessions as a cookie
 * on the web and a bearer token in native shells, and an OAuth authorization server for
 * MCP clients (MCP 2026-07-28: protected resource metadata, Client ID Metadata Documents,
 * PKCE, tokens bound to `/_parlor/mcp`).
 */
export function parlorAuth(options: ParlorAuthOptions): BetterAuthOptions {
  const { origin: _origin, signInPage, ...rest } = options;
  const origin = originOf(options);
  const baseURL = `${origin}${AUTH_BASE_PATH}`;
  const resource = `${origin}${DEFAULT_BASE_PATH}/mcp`;
  const bridge: Bridge = { settings: { origin, baseURL, resource } };
  const trusted = rest.trustedOrigins;
  return {
    ...rest,
    baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: Array.isArray(trusted)
      ? [origin, ...SHELL_ORIGINS, ...trusted]
      : async (request) => [
          origin,
          ...SHELL_ORIGINS,
          ...(typeof trusted === "function" ? await trusted(request) : []),
        ],
    disabledPaths: [...DISABLED_PATHS, ...(rest.disabledPaths ?? [])],
    plugins: [
      ...(rest.plugins ?? []),
      ...frameworkPlugins(resource, signInPage),
      bridgePlugin(bridge),
    ],
  };
}

function frameworkPlugins(resource: string, signInPage: string): BetterAuthPlugin[] {
  // Better Auth's plugin types are not written for exactOptionalPropertyTypes.
  return [
    bearer(),
    jwt(),
    mcp({
      resource,
      loginPage: signInPage,
      consentPage: `${AUTH_BASE_PATH}${CONSENT_PATH}`,
      scopes: [MCP_SCOPE, "offline_access"],
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_S,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ] as BetterAuthPlugin[];
}
