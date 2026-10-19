import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ActionError,
  asId,
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
  AuthFailure,
  type DeviceKeys,
  type Migration,
  type PluginHost,
  pluginRoute,
  SHELL_ORIGINS,
} from "@parlor/server";
import { sql } from "drizzle-orm";
import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader } from "jose";
import { z } from "zod";

import { signedIn } from "./account.js";
import { AUTH_PLUGIN, type ParlorAuthSettings } from "./better-auth.js";
import { type Database, jwkOf, rowsOf } from "./database.js";
import { escape, failure, page } from "./pages.js";
import type { RevocationNotice } from "./revocation.js";
import { HOST_ASSERTION_TYP, HOST_AUDIENCE, type HostAssertion } from "./tokens.js";

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

const GRANT_KEY_TTL_MS = 5 * 60_000;
const GRANT_KEY_CACHE_SIZE = 10_000;
const REPLAY_CACHE_SIZE = 100_000;
const CLOCK_SKEW_MS = 5_000;

export interface GrantKeysOptions {
  /** How long a loaded key is trusted; must stay below the revocation horizon. */
  readonly ttlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

interface GrantRow {
  readonly grant_id: string;
  readonly user_id: string;
  readonly host_id: string;
  readonly public_key: JsonWebKey | string;
  readonly kid: string;
}

const verifyKeys = new WeakMap<GrantKey, Promise<CryptoKey>>();
const replays = new WeakMap<GrantKeys, Map<string, number>>();

const EC_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

function verifyKeyOf(grant: GrantKey): Promise<CryptoKey> {
  let key = verifyKeys.get(grant);
  if (!key) {
    key = crypto.subtle.importKey("jwk", grant.publicKey, EC_P256, false, ["verify"]);
    verifyKeys.set(grant, key);
  }
  return key;
}

/**
 * A grant's key after one primary-key lookup, kept for a few minutes. A grant revoked
 * meanwhile has no row, and `RevocationSet` (which outlasts the cache) refuses it until the
 * cache lets go.
 */
export function createGrantKeys(
  database: DataProvider,
  options: GrantKeysOptions = {},
): GrantKeys {
  const ttlMs = options.ttlMs ?? GRANT_KEY_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly key: GrantKey; readonly loadedAt: number }>();
  const loading = new Map<string, Promise<GrantKey | undefined>>();

  const load = async (grantId: GrantId): Promise<GrantKey | undefined> => {
    const rows = rowsOf<GrantRow>(
      await (database.read() as Database).execute(sql`
        select grant_id, user_id, host_id, public_key, kid from parlor_auth_hosts
        where grant_id = ${grantId}`),
    );
    const row = rows[0];
    if (!row) return undefined;
    const key: GrantKey = {
      grantId: asId("grant", row.grant_id),
      userId: asId("user", row.user_id),
      hostId: asId("host", row.host_id),
      publicKey: jwkOf(row.public_key),
      kid: row.kid,
    };
    cache.set(grantId, { key, loadedAt: now() });
    while (cache.size > GRANT_KEY_CACHE_SIZE) {
      cache.delete(cache.keys().next().value as string);
    }
    return key;
  };

  return {
    async get(grantId) {
      const hit = cache.get(grantId);
      if (hit && now() - hit.loadedAt < ttlMs) return hit.key;
      cache.delete(grantId);
      let pending = loading.get(grantId);
      if (!pending) {
        pending = load(grantId).finally(() => loading.delete(grantId));
        loading.set(grantId, pending);
      }
      return pending;
    },
  };
}

const assertionClaims = z.object({
  aud: z.literal(HOST_AUDIENCE),
  gid: z.string().min(1),
  htm: z.enum(["GET", "POST"]),
  htu: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8).max(128),
});

const withoutQuery = (url: string): string => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
};

function claimJti(keys: GrantKeys, grantId: string, jti: string, now: number): boolean {
  let seen = replays.get(keys);
  if (!seen) replays.set(keys, (seen = new Map()));
  for (const [id, expiresAt] of seen) {
    if (expiresAt > now) break;
    seen.delete(id);
  }
  const id = `${grantId}:${jti}`;
  if (seen.has(id)) return false;
  while (seen.size >= REPLAY_CACHE_SIZE) seen.delete(seen.keys().next().value as string);
  seen.set(id, now + HOST_ASSERTION_TTL_MS);
  return true;
}

function claimsOf(assertion: HostAssertion): { gid: string; kid: string | undefined } {
  try {
    const header = decodeProtectedHeader(assertion);
    const payload = JSON.parse(
      Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { gid?: unknown };
    if (header.typ !== HOST_ASSERTION_TYP || typeof payload.gid !== "string") {
      throw new Error("not a host assertion");
    }
    return { gid: payload.gid, kid: header.kid };
  } catch {
    throw new AuthFailure("invalid", "The host assertion is malformed.");
  }
}

export async function verifyHostAssertion(
  assertion: HostAssertion,
  request: { readonly method: string; readonly url: string },
  keys: GrantKeys,
  now: number,
): Promise<GrantKey> {
  const { gid, kid } = claimsOf(assertion);
  const grant = await keys.get(asId("grant", gid));
  if (!grant || kid !== grant.kid) {
    throw new AuthFailure("invalid", "This computer is not connected.");
  }
  let payload: unknown;
  try {
    const verified = await compactVerify(assertion, await verifyKeyOf(grant), {
      algorithms: ["ES256"],
    });
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw new AuthFailure(
      "invalid",
      "The host assertion is not signed by this computer.",
    );
  }
  const parsed = assertionClaims.safeParse(payload);
  if (!parsed.success)
    throw new AuthFailure("invalid", "The host assertion is malformed.");
  const claims = parsed.data;
  if (claims.htm !== request.method) {
    throw new AuthFailure("invalid", "The host assertion is for another method.");
  }
  let sameUrl: boolean;
  try {
    sameUrl = withoutQuery(claims.htu) === withoutQuery(request.url);
  } catch {
    sameUrl = false;
  }
  if (!sameUrl)
    throw new AuthFailure("invalid", "The host assertion is for another URL.");
  const issuedAt = claims.iat * 1000;
  if (
    claims.exp - claims.iat > HOST_ASSERTION_TTL_MS / 1000 ||
    issuedAt - now > CLOCK_SKEW_MS
  ) {
    throw new AuthFailure("invalid", "The host assertion has an impossible lifetime.");
  }
  if (now - issuedAt > HOST_ASSERTION_TTL_MS || claims.exp * 1000 <= now) {
    throw new AuthFailure("expired", "The host assertion expired.");
  }
  if (!claimJti(keys, grant.grantId, claims.jti, now)) {
    throw new AuthFailure("invalid", "The host assertion was already used.");
  }
  return grant;
}

export function hostPrincipalOf(grant: GrantKey): HostPrincipal {
  return {
    kind: "host",
    userId: grant.userId,
    grantId: grant.grantId,
    hostId: grant.hostId,
  };
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
  /** Records the revocation in the caller's transaction, so it commits with the key's removal. */
  readonly revoke: (tx: unknown, notice: RevocationNotice) => Promise<void>;
}

function databaseOf(host: PluginHost): DataProvider {
  if (!host.database) throw new Error("Host grants need a database.");
  return host.database;
}

interface RemovedGrant {
  readonly grant_id: string;
  readonly host_id: string;
}

/**
 * Deleting the key row is what keeps a host out for good: `RevocationSet` forgets a
 * revocation after its horizon, but a host assertion's `iat` is always fresh, so only a grant
 * with no row stays refused.
 */
async function removeGrant(
  deps: HostGrantDeps,
  match: { readonly hostId: string } | { readonly grantId: string },
  userId: string,
): Promise<RemovedGrant | undefined> {
  return databaseOf(deps.host).transaction(async (handle) => {
    const tx = handle as Database;
    const removed = rowsOf<RemovedGrant>(
      await tx.execute(
        "hostId" in match
          ? sql`delete from parlor_auth_hosts where host_id = ${match.hostId} and user_id = ${userId} returning grant_id, host_id`
          : sql`delete from parlor_auth_hosts where grant_id = ${match.grantId} and user_id = ${userId} returning grant_id, host_id`,
      ),
    )[0];
    if (!removed) return undefined;
    await deps.revoke(tx, { kind: "grant", id: removed.grant_id });
    return removed;
  });
}

interface HostListRow {
  readonly host_id: string;
  readonly name: string;
  readonly platform: string;
  readonly created_at: string | Date;
  readonly last_used_at: string | Date | null;
}

const isoOf = (value: string | Date): string => new Date(value).toISOString();

/** `hosts` and `revokeHost`, merged into the account actions once host grants land. */
export function hostAccountActions(deps: HostGrantDeps) {
  return createRegistry({
    hosts: defineAction({
      description: "List the computers connected to this account.",
      input: z.object({}),
      reads: [HOSTS_TAG],
      run: async (_input, ctx): Promise<ConnectedHost[]> => {
        const user = signedIn(ctx);
        const rows = rowsOf<HostListRow>(
          await (databaseOf(deps.host).read() as Database).execute(sql`
            select host_id, name, platform, created_at, last_used_at from parlor_auth_hosts
            where user_id = ${user.userId} order by created_at, host_id`),
        );
        return rows.map((row) => ({
          hostId: asId("host", row.host_id),
          name: row.name,
          platform: row.platform,
          connectedAt: isoOf(row.created_at),
          lastUsedAt: row.last_used_at === null ? null : isoOf(row.last_used_at),
        }));
      },
    }),
    revokeHost: defineAction({
      description:
        "Disconnect a computer; its grant, turn tokens and stream end at once.",
      input: z.object({ hostId: z.string().min(1) }),
      run: async ({ hostId }, ctx): Promise<{ readonly id: string }> => {
        const user = signedIn(ctx);
        const removed = await removeGrant(deps, { hostId }, user.userId);
        if (!removed) throw new ActionError("not_found", `No computer ${hostId}`);
        await deps.host.announce(ctx.scope, [[HOSTS_TAG, hostId]]);
        return { id: hostId };
      },
    }),
  });
}

export type HostAccountActions = ActionsOf<ReturnType<typeof hostAccountActions>>;

const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const isPrintable = (text: string) =>
  [...text].every((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f;
  });
const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/callback$/;
const IPC_REDIRECT = "urn:parlor:ipc";
const CODE_TTL_MS = 10 * 60_000;

function isHostRedirect(value: unknown): value is HostRedirect {
  if (value === IPC_REDIRECT) return true;
  if (typeof value !== "string") return false;
  const port = LOOPBACK.exec(value)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535;
}

const authorizeRequest = z.object({
  redirectUri: z.custom<HostRedirect>(isHostRedirect, "Use a loopback redirect."),
  codeChallenge: z.string().regex(THUMBPRINT),
  state: z.string().min(1).max(256),
  hostName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isPrintable, "Use printable characters."),
  platform: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine(isPrintable, "Use printable characters."),
  matchingCode: z.string().regex(MATCHING_CODE),
  keyThumbprint: z.string().regex(THUMBPRINT),
});

const authorizeAnswer = authorizeRequest.extend({
  decision: z.enum(["connect", "cancel"]),
});

const publicKeySchema = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(THUMBPRINT),
  y: z.string().regex(THUMBPRINT),
});

const keyExchange = z.object({
  code: z.string().min(16).max(256),
  codeVerifier: z.string().min(43).max(128),
  publicKey: publicKeySchema,
  proof: z.string().min(1).max(256),
});

const MAX_BODY_BYTES = 16 * 1024;

const sha256 = (text: string, encoding: "hex" | "base64url") =>
  createHash("sha256").update(text).digest(encoding);

function sameText(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

async function bodyOf(
  request: Request,
): Promise<{ readonly json: boolean; readonly fields: unknown }> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { json: false, fields: undefined };
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      return { json: true, fields: JSON.parse(text) as unknown };
    } catch {
      return { json: true, fields: undefined };
    }
  }
  return { json: false, fields: Object.fromEntries(new URLSearchParams(text)) };
}

function invalidGrant(): Response {
  return Response.json(
    {
      error: {
        code: "invalid_grant",
        message: "The pairing code is invalid, expired or already used.",
      },
    },
    { status: 400 },
  );
}

interface PairingCode {
  readonly user_id: string;
  readonly code_challenge: string;
  readonly key_thumbprint: string;
  readonly host_name: string;
  readonly platform: string;
  readonly expires_at: string | Date;
}

async function verifyProof(
  publicKey: JsonWebKey,
  code: string,
  proof: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", publicKey, EC_P256, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(proof, "base64url"),
      new TextEncoder().encode(code),
    );
  } catch {
    return false;
  }
}

/**
 * `GET|POST /hosts/authorize` is the framework-owned consent page and its answer, `POST
 * /hosts/token` the PKCE exchange binding the host's key, `POST /hosts/revoke` the host
 * disconnecting itself.
 */
export function hostRoutes(deps: HostGrantDeps): readonly AnyPluginRoute[] {
  const { host, settings } = deps;
  const appName = () =>
    process.env.PARLOR_APP_NAME ?? settings.appName ?? new URL(settings.origin).host;
  const authorizeUrl = `${host.basePath}/${AUTH_PLUGIN}/hosts/authorize`;
  const accountOf = async (userId: UserId) => host.auth?.account?.(userId);

  return [
    pluginRoute({
      method: "GET",
      path: "/hosts/authorize",
      access: ["user"],
      handle: async (request, caller) => {
        const parsed = authorizeRequest.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!parsed.success) {
          return failure("This connection request is incomplete.", 400);
        }
        const pairing = parsed.data;
        const profile = await accountOf(caller.principal.userId);
        const app = appName();
        const hidden = Object.entries(pairing)
          .map(
            ([name, value]) =>
              `<input type="hidden" name="${name}" value="${escape(String(value))}">`,
          )
          .join("\n");
        const body = `
<h1>Connect a computer to ${escape(app)}?</h1>
<p>Signed in as <strong>${escape(profile?.email ?? profile?.name ?? "your account")}</strong>.</p>
<p><strong>${escape(pairing.hostName)}</strong> (${escape(pairing.platform)}) wants to run agents for your account. Continue only if you started this on that computer, and its matching code is:</p>
<p class="code">${escape(pairing.matchingCode)}</p>
<form method="post" action="${escape(authorizeUrl)}">
${hidden}
<button type="submit" name="decision" value="cancel">Cancel</button>
<button type="submit" name="decision" value="connect">Connect</button>
</form>`;
        const target =
          pairing.redirectUri === IPC_REDIRECT
            ? []
            : [new URL(pairing.redirectUri).origin];
        return page("Connect a computer", body, ["'self'", ...target]);
      },
    }),
    pluginRoute({
      method: "POST",
      path: "/hosts/authorize",
      access: ["user"],
      handle: async (request, caller) => {
        const { json, fields } = await bodyOf(request);
        const refuse = (status: number, code: string, message: string) =>
          json
            ? Response.json({ error: { code, message } }, { status })
            : failure(message, status);
        const origin = request.headers.get("origin");
        if (origin !== settings.origin && !(origin && SHELL_ORIGINS.includes(origin))) {
          return refuse(
            403,
            "forbidden",
            "This answer did not come from the consent page.",
          );
        }
        const parsed = authorizeAnswer.safeParse(fields);
        if (!parsed.success) {
          return refuse(400, "invalid_input", "This connection request is incomplete.");
        }
        const { decision, ...pairing } = parsed.data;
        const target =
          pairing.redirectUri === IPC_REDIRECT ? undefined : new URL(pairing.redirectUri);
        if (decision === "cancel") {
          if (!target)
            return Response.json({ error: "access_denied", state: pairing.state });
          target.searchParams.set("error", "access_denied");
          target.searchParams.set("state", pairing.state);
          return new Response(null, { status: 303, headers: { location: target.href } });
        }
        const code = randomBytes(32).toString("base64url");
        await databaseOf(host).transaction(async (handle) => {
          const tx = handle as Database;
          await tx.execute(
            sql`delete from parlor_auth_host_codes where expires_at < ${new Date().toISOString()}`,
          );
          await tx.execute(sql`
            insert into parlor_auth_host_codes
              (code_hash, user_id, code_challenge, key_thumbprint, redirect_uri, host_name, platform, expires_at)
            values (${sha256(code, "hex")}, ${caller.principal.userId}, ${pairing.codeChallenge},
              ${pairing.keyThumbprint}, ${pairing.redirectUri}, ${pairing.hostName}, ${pairing.platform},
              ${new Date(Date.now() + CODE_TTL_MS).toISOString()})`);
        });
        if (!target) return Response.json({ code, state: pairing.state });
        target.searchParams.set("code", code);
        target.searchParams.set("state", pairing.state);
        return new Response(null, { status: 303, headers: { location: target.href } });
      },
    }),
    {
      method: "POST",
      path: "/hosts/token",
      access: "public",
      handle: async (request) => {
        const { fields } = await bodyOf(request);
        const exchange = keyExchange.safeParse(fields);
        if (!exchange.success || "d" in exchange.data.publicKey) return invalidGrant();
        const { code, codeVerifier, proof } = exchange.data;
        const { kty, crv, x, y } = exchange.data.publicKey;
        const publicKey: JsonWebKey = { kty, crv, x, y };
        const database = databaseOf(host);
        const stored = await database.transaction(
          async (handle) =>
            rowsOf<PairingCode>(
              await (handle as Database).execute(sql`
              delete from parlor_auth_host_codes where code_hash = ${sha256(code, "hex")}
              returning user_id, code_challenge, key_thumbprint, host_name, platform, expires_at`),
            )[0],
        );
        if (
          !stored ||
          new Date(stored.expires_at).getTime() <= Date.now() ||
          !sameText(sha256(codeVerifier, "base64url"), stored.code_challenge) ||
          !sameText(
            await calculateJwkThumbprint(publicKey, "sha256"),
            stored.key_thumbprint,
          ) ||
          !(await verifyProof(publicKey, code, proof))
        ) {
          return invalidGrant();
        }
        const grantId = asId("grant", `host:${crypto.randomUUID()}`);
        const hostId = asId("host", crypto.randomUUID());
        const userId = asId("user", stored.user_id);
        await database.transaction(async (handle) => {
          await (handle as Database).execute(sql`
            insert into parlor_auth_hosts (grant_id, host_id, user_id, name, platform, public_key, kid)
            values (${grantId}, ${hostId}, ${userId}, ${stored.host_name}, ${stored.platform},
              ${JSON.stringify(publicKey)}::jsonb, ${stored.key_thumbprint})`);
        });
        await host.announce(userId, [[HOSTS_TAG, hostId]]);
        const profile = await accountOf(userId);
        const response: HostGrantResponse = {
          grant: { id: grantId, hostId },
          account: { userId, name: profile?.name ?? "", email: profile?.email },
        };
        return Response.json(response);
      },
    },
    pluginRoute({
      method: "POST",
      path: "/hosts/revoke",
      access: ["host"],
      handle: async (_request, caller) => {
        const { userId, grantId } = caller.principal;
        const removed = await removeGrant(deps, { grantId }, userId);
        if (removed) await host.announce(caller.scope, [[HOSTS_TAG, removed.host_id]]);
        return Response.json({ id: grantId });
      },
    }),
  ];
}
