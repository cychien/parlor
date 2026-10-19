import {
  type DataProvider,
  defineAction,
  type GrantId,
  type HostId,
  type HostPrincipal,
  type UserId,
} from "@parlor/core";
import { type ActionsOf, createRegistry } from "@parlor/core/registry";
import {
  type AnyPluginRoute,
  type DeviceKeys,
  type Migration,
  type PluginHost,
  pluginRoute,
} from "@parlor/server";
import { z } from "zod";

import type { ParlorAuthSettings } from "./better-auth.js";
import type { RevocationNotice } from "./revocation.js";
import type { HOST_AUDIENCE, HostAssertion } from "./tokens.js";

export const HOST_CLIENT_ID = "parlor-host";

export const MATCHING_CODE = /^[A-Z2-9]{3}-[A-Z2-9]{3}$/;

export type HostRedirect = `http://127.0.0.1:${number}/callback` | "urn:parlor:ipc";

export interface HostAuthorizeRequest {
  readonly redirectUri: HostRedirect;
  readonly codeChallenge: string;
  readonly state: string;
  readonly hostName: string;
  readonly platform: string;
  readonly matchingCode: string;
  /** RFC 7638 thumbprint of the key the code exchange must be signed with. */
  readonly keyThumbprint: string;
}

/** `POST /hosts/token` */
export interface HostKeyExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly publicKey: JsonWebKey;
  /** ES256 over the code with the key the authorize request named. */
  readonly proof: string;
}

export interface AccountSummary {
  readonly userId: UserId;
  readonly name: string;
  readonly email?: string | undefined;
}

/** The device that approved the pairing; the host pins it as trusted once confirmed locally. */
export type ApprovingDevice = DeviceKeys;

export interface HostGrantResponse {
  readonly grant: { readonly id: GrantId; readonly hostId: HostId };
  /** The host shows it locally before it keeps the grant. */
  readonly account: AccountSummary;
  readonly approvedBy?: ApprovingDevice | undefined;
}

export const HOST_ASSERTION_TTL_MS = 60_000;

/** `authorization: ParlorHost <jws>`, DPoP style: bound to one method and URL, dead in a minute. */
export interface HostAssertionClaims {
  readonly aud: typeof HOST_AUDIENCE;
  readonly gid: string;
  readonly htm: "GET" | "POST";
  /** without the query */
  readonly htu: string;
  readonly iat: number;
  readonly exp: number;
  /** replay-checked in a bounded per-instance LRU over the TTL window */
  readonly jti: string;
}

/** A grant as the server stores it: only the computer's public key. */
export interface GrantKey {
  readonly grantId: GrantId;
  readonly userId: UserId;
  readonly hostId: HostId;
  readonly publicKey: JsonWebKey;
  readonly kid: string;
}

/** In memory after one primary-key lookup; dropped when `RevocationSet` reports the grant. */
export interface GrantKeys {
  get(grantId: GrantId): Promise<GrantKey | undefined>;
}

export function createGrantKeys(database: DataProvider): GrantKeys {
  void database;
  throw new Error("not implemented");
}

export async function verifyHostAssertion(
  assertion: HostAssertion,
  request: { readonly method: string; readonly url: string },
  keys: GrantKeys,
  now: number,
): Promise<GrantKey> {
  // TODO: decode; grant = keys.get(gid) (unknown -> AuthFailure "invalid"); header kid ===
  //   grant.kid; ES256 verify with grant.publicKey; htm/htu equal the request (URL without
  //   query); now - iat <= HOST_ASSERTION_TTL_MS and exp > now; jti unseen -> else invalid.
  //   The caller then checks the grant against RevocationSet.
  void assertion;
  void request;
  void keys;
  void now;
  throw new Error("not implemented");
}

export function hostPrincipalOf(grant: GrantKey): HostPrincipal {
  void grant;
  throw new Error("not implemented");
}

export const HOSTS_TAG = "parlor_auth_hosts";

export const HOSTS_MIGRATION: Migration = {
  id: "auth/0003_hosts",
  sql: `
    create table parlor_auth_hosts (
      grant_id text primary key,
      host_id text not null unique,
      user_id text not null,
      name text not null,
      platform text not null,
      public_key jsonb not null,
      kid text not null,
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    );
    create index parlor_auth_hosts_user on parlor_auth_hosts (user_id);

    create table parlor_auth_host_codes (
      code_hash text primary key,
      user_id text not null,
      code_challenge text not null,
      key_thumbprint text not null,
      redirect_uri text not null,
      host_name text not null,
      platform text not null,
      device_id text,
      expires_at timestamptz not null
    )`,
};

export interface ConnectedHost {
  readonly hostId: HostId;
  readonly name: string;
  readonly platform: string;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

export interface HostGrantDeps {
  readonly host: PluginHost;
  readonly settings: ParlorAuthSettings;
  readonly keys: GrantKeys;
  readonly revoke: (notice: RevocationNotice) => Promise<void>;
}

/** `hosts` and `revokeHost`, merged into the account actions once host grants land. */
export function hostAccountActions(deps: HostGrantDeps) {
  return createRegistry({
    hosts: defineAction({
      description: "List the computers connected to this account.",
      input: z.object({}),
      reads: [HOSTS_TAG],
      run: (): ConnectedHost[] => {
        void deps;
        throw new Error("not implemented");
      },
    }),
    revokeHost: defineAction({
      description:
        "Disconnect a computer; its grant, turn tokens and stream end at once.",
      input: z.object({ hostId: z.string().min(1) }),
      // TODO: revoke({ kind: "grant", id: grantId }), delete the row, then
      //   host.announce(scope, [[HOSTS_TAG, hostId]]) so every chat drops the computer.
      run: (): { readonly id: string } => {
        throw new Error("not implemented");
      },
    }),
  });
}

export type HostAccountActions = ActionsOf<ReturnType<typeof hostAccountActions>>;

/**
 * `GET|POST /hosts/authorize` is the framework-owned consent page and its answer, `POST
 * /hosts/token` the PKCE exchange binding the host's key, `POST /hosts/revoke` the host
 * disconnecting itself.
 */
export function hostRoutes(deps: HostGrantDeps): readonly AnyPluginRoute[] {
  const notImplemented = (): never => {
    void deps;
    throw new Error("not implemented");
  };
  return [
    pluginRoute({
      method: "GET",
      path: "/hosts/authorize",
      access: ["user"],
      handle: notImplemented,
    }),
    pluginRoute({
      method: "POST",
      path: "/hosts/authorize",
      access: ["user"],
      // TODO: check Origin; with stepUpPairing require a presence signature; store a
      //   single-use code bound to codeChallenge, keyThumbprint and the approving device;
      //   redirect to redirectUri, or for urn:parlor:ipc answer the code as JSON.
      handle: notImplemented,
    }),
    {
      method: "POST",
      path: "/hosts/token",
      access: "public",
      // TODO: HostKeyExchange; S256(codeVerifier) === codeChallenge; thumbprint(publicKey)
      //   === keyThumbprint; proof verifies over code; insert parlor_auth_hosts; answer
      //   HostGrantResponse. The code is consumed whatever the outcome.
      handle: notImplemented,
    },
    pluginRoute({
      method: "POST",
      path: "/hosts/revoke",
      access: ["host"],
      handle: notImplemented,
    }),
  ];
}
