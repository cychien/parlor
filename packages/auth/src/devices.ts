import { randomBytes } from "node:crypto";

import type { PresencePublicKey } from "@parlor/capabilities";
import { decodeBase64url, enrollmentBytes } from "@parlor/capabilities/encoding";
import {
  ActionError,
  asId,
  type DataProvider,
  defineAction,
  type DeviceId,
  type UserId,
} from "@parlor/core";
import { type ActionsOf, createRegistry } from "@parlor/core/registry";
import type {
  DeviceKeys,
  DeviceVouch,
  Migration,
  PluginHost,
  PresenceKey,
} from "@parlor/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { signedIn } from "./account.js";
import { type Database, jwkOf, rowsOf } from "./database.js";
import { verifyEs256 } from "./es256.js";
import {
  LINK_CODE_LENGTH,
  normalizeLinkCode,
  removeStatement,
  verifyStatement,
  vouchStatement,
} from "./statements.js";

export type { PresenceKey } from "@parlor/server";

export interface RegisteredDevice extends DeviceKeys {
  readonly userId: UserId;
  readonly createdAt: number;
  readonly revokedAt?: number | undefined;
}

export interface DeviceRegistry {
  /** A revoked device reads as undefined, so no host accepts its signatures again. */
  get(userId: UserId, deviceId: DeviceId): Promise<RegisteredDevice | undefined>;
}

interface DeviceRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly platform: string;
  readonly signing_key: JsonWebKey | string;
  readonly presence_key: PresenceKey | string | null;
  readonly created_ms: string | number;
  readonly vouches: DeviceVouch[] | string | null;
}

const parsed = <T>(value: T | string | null): T | null =>
  typeof value === "string" ? (JSON.parse(value) as T) : value;

export function createDeviceRegistry(database: DataProvider): DeviceRegistry {
  return {
    async get(userId, deviceId) {
      const [row] = rowsOf<DeviceRow>(
        await (database.read() as Database).execute(sql`
          select id, user_id, name, platform, signing_key, presence_key, vouches,
            (extract(epoch from created_at) * 1000)::bigint as created_ms
          from parlor_auth_devices
          where id = ${deviceId} and user_id = ${userId} and revoked_at is null`),
      );
      if (!row) return undefined;
      const presence = parsed(row.presence_key);
      const vouches = parsed(row.vouches) ?? [];
      return {
        id: asId("device", row.id),
        userId: asId("user", row.user_id),
        name: row.name,
        platform: row.platform,
        signingKey: jwkOf(row.signing_key),
        presenceKey: presence ?? undefined,
        ...(vouches.length > 0 ? { vouches } : {}),
        createdAt: Number(row.created_ms),
      };
    },
  };
}

export const DEVICES_TAG = "parlor_auth_devices";

export const DEVICES_MIGRATION: Migration = {
  id: "auth/0004_devices",
  sql: `
    create table parlor_auth_devices (
      id text primary key,
      user_id text not null,
      name text not null,
      platform text not null,
      signing_key jsonb not null,
      presence_key jsonb,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    );
    create index parlor_auth_devices_user on parlor_auth_devices (user_id);
    create unique index parlor_auth_devices_signing_key on parlor_auth_devices
      (user_id, (signing_key->>'x'), (signing_key->>'y')) where revoked_at is null;

    create table parlor_auth_device_challenges (
      challenge text primary key,
      user_id text not null,
      expires_at timestamptz not null
    )`,
};

export const DEVICE_LINKING_MIGRATION: Migration = {
  id: "auth/0007_device_linking",
  sql: `
    alter table parlor_auth_devices add column vouches jsonb not null default '[]'::jsonb;
    alter table parlor_auth_devices add column link_code text;
    alter table parlor_auth_devices add column link_expires_at timestamptz;
    create index parlor_auth_devices_link_code on parlor_auth_devices (user_id, link_code)
      where link_code is not null`,
};

export interface ConnectedDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly platform: string;
  readonly current: boolean;
  readonly createdAt: string;
  /** A linked device vouched for it; the computer pins it on its first prompt. */
  readonly vouched: boolean;
  /** It is showing a link code now. */
  readonly linking: boolean;
  /** The device whose vouch linked it last. */
  readonly linkedBy?: string | undefined;
}

/** A device waiting to be linked, as the one linking it checks it against the code. */
export interface PendingDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly platform: string;
  readonly signingKey: JsonWebKey;
  readonly presenceKey?: PresenceKey | undefined;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
const VOUCH_MAX_AGE_MS = 5 * 60_000;
const linkCodeInput = z
  .string()
  .min(LINK_CODE_LENGTH)
  .max(32)
  .transform(normalizeLinkCode)
  .refine(
    (code) => /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code),
    "Enter the 10-character code.",
  );
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

const jwk = z.record(z.string(), z.unknown());

const deviceSignature = z.object({
  keyId: z.string(),
  presence: z.enum(["none", "user"]),
  format: z.enum(["es256-raw", "webauthn"]),
  signature: z.string(),
  authenticatorData: z.string().optional(),
  clientDataJSON: z.string().optional(),
});

const presenceInput = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("webauthn"),
    credentialId: z.string().min(1).max(1024),
    rpId: z.string().min(1).max(255),
    publicKey: jwk,
    attestation: z.string().min(1),
  }),
  z.object({
    format: z.literal("es256-raw"),
    keyId: z.string().min(1),
    publicKey: jwk,
  }),
]);

export interface DeviceActionDeps {
  readonly host: PluginHost;
  readonly registry: DeviceRegistry;
}

interface DeviceListRow {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly created_at: string | Date;
  readonly vouched: boolean;
  readonly linking: boolean;
  readonly linked_by: string | null;
}

function databaseOf(host: PluginHost): DataProvider {
  if (!host.database) throw new Error("Devices need a database.");
  return host.database;
}

const invalid = (message: string) => new ActionError("invalid_input", message);

async function pointOf(key: Record<string, unknown>): Promise<JsonWebKey> {
  try {
    const imported = await crypto.subtle.importKey("jwk", key as JsonWebKey, P256, true, [
      "verify",
    ]);
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", imported);
    return { kty: kty!, crv: crv!, x: x!, y: y! };
  } catch {
    throw invalid("A device key must be an ECDSA P-256 public key.");
  }
}

interface EnrolledPresence {
  readonly stored: PresenceKey;
  readonly proven: PresencePublicKey;
}

async function presenceOf(
  input: z.output<typeof presenceInput> | undefined,
): Promise<EnrolledPresence | undefined> {
  if (!input) return undefined;
  const publicKey = await pointOf(input.publicKey);
  if (input.format === "webauthn") {
    const { credentialId, rpId, attestation } = input;
    return {
      stored: { format: "webauthn", credentialId, rpId, publicKey },
      proven: { format: "webauthn", credentialId, publicKey, attestation },
    };
  }
  const key: PresencePublicKey = { format: "es256-raw", keyId: input.keyId, publicKey };
  return { stored: key, proven: key };
}

const isoOf = (value: string | Date): string => new Date(value).toISOString();

/**
 * A device showing a link code, found by the code (normalized) or, from its QR, by its id;
 * only `userId`'s own device, still within its 15 minutes.
 */
export async function findPendingDevice(
  database: DataProvider,
  userId: UserId,
  by: { readonly code: string } | { readonly device: string },
): Promise<PendingDevice | undefined> {
  const match =
    "code" in by
      ? sql`link_code = ${normalizeLinkCode(by.code)}`
      : sql`id = ${by.device} and link_code is not null`;
  const [row] = rowsOf<DeviceRow>(
    await (database.read() as Database).execute(sql`
      select id, user_id, name, platform, signing_key, presence_key, vouches, 0 as created_ms
      from parlor_auth_devices
      where user_id = ${userId} and ${match}
        and link_expires_at > ${new Date().toISOString()} and revoked_at is null`),
  );
  if (!row) return undefined;
  const presence = parsed(row.presence_key);
  return {
    id: asId("device", row.id),
    name: row.name,
    platform: row.platform,
    signingKey: jwkOf(row.signing_key),
    ...(presence ? { presenceKey: presence } : {}),
  };
}

export function deviceAccountActions(deps: DeviceActionDeps) {
  return createRegistry({
    devices: defineAction({
      description: "List the devices that sign this account's chat messages.",
      input: z.object({}),
      reads: [DEVICES_TAG],
      run: async (_input, ctx): Promise<ConnectedDevice[]> => {
        const user = signedIn(ctx);
        const rows = rowsOf<DeviceListRow>(
          await (databaseOf(deps.host).read() as Database).execute(sql`
            select id, name, platform, created_at, jsonb_array_length(vouches) > 0 as vouched,
              coalesce(link_expires_at > ${new Date().toISOString()}, false) as linking,
              vouches -> -1 ->> 'voucher' as linked_by
            from parlor_auth_devices
            where user_id = ${user.userId} and revoked_at is null order by created_at, id`),
        );
        return rows.map((row) => ({
          id: asId("device", row.id),
          name: row.name,
          platform: row.platform,
          current: row.id === user.deviceId,
          createdAt: isoOf(row.created_at),
          vouched: row.vouched,
          linking: row.linking,
          ...(row.linked_by ? { linkedBy: row.linked_by } : {}),
        }));
      },
    }),
    deviceChallenge: defineAction({
      description: "A single-use challenge for enrolling this device.",
      input: z.object({}),
      run: async (_input, ctx): Promise<{ readonly challenge: string }> => {
        const user = signedIn(ctx);
        const challenge = randomBytes(32).toString("base64url");
        await databaseOf(deps.host).transaction(async (handle) => {
          const tx = handle as Database;
          await tx.execute(
            sql`delete from parlor_auth_device_challenges where expires_at < ${new Date().toISOString()}`,
          );
          await tx.execute(sql`
            insert into parlor_auth_device_challenges (challenge, user_id, expires_at)
            values (${challenge}, ${user.userId},
              ${new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()})`);
        });
        return { challenge };
      },
    }),
    enrollDevice: defineAction({
      description: "Register this device's public keys, proven by signing a challenge.",
      input: z.object({
        name: z.string().min(1).max(80),
        platform: z.string().min(1).max(32),
        challenge: z.string().min(1).max(256),
        signing: z.object({ keyId: z.string().min(1), publicKey: jwk }),
        presence: presenceInput.optional(),
        proof: deviceSignature,
      }),
      run: async (input, ctx): Promise<{ readonly id: DeviceId }> => {
        const user = signedIn(ctx);
        const signing = await pointOf(input.signing.publicKey);
        const presence = await presenceOf(input.presence);
        const { proof } = input;
        let proven = false;
        try {
          proven =
            proof.format === "es256-raw" &&
            proof.presence === "none" &&
            (await verifyEs256(
              signing,
              decodeBase64url(proof.signature),
              enrollmentBytes({
                challenge: decodeBase64url(input.challenge),
                signing,
                presence: presence?.proven,
              }),
            ));
        } catch {
          proven = false;
        }
        if (!proven) throw invalid("The device could not prove it holds its keys.");
        const enrolled = await databaseOf(deps.host).transaction(async (handle) => {
          const tx = handle as Database;
          const consumed = rowsOf<{ readonly challenge: string }>(
            await tx.execute(sql`
              delete from parlor_auth_device_challenges
              where challenge = ${input.challenge} and user_id = ${user.userId}
                and expires_at >= ${new Date().toISOString()}
              returning challenge`),
          );
          if (consumed.length === 0)
            throw invalid("This challenge is unknown or expired.");
          const id = asId("device", randomBytes(16).toString("base64url"));
          const [inserted] = rowsOf<{ readonly id: string }>(
            await tx.execute(sql`
              insert into parlor_auth_devices (id, user_id, name, platform, signing_key, presence_key)
              values (${id}, ${user.userId}, ${input.name}, ${input.platform},
                ${JSON.stringify(signing)}::jsonb,
                ${presence ? JSON.stringify(presence.stored) : null}::jsonb)
              on conflict (user_id, (signing_key->>'x'), (signing_key->>'y'))
                where revoked_at is null do nothing
              returning id`),
          );
          if (!inserted) {
            const [existing] = rowsOf<{ readonly id: string }>(
              await tx.execute(sql`
                select id from parlor_auth_devices
                where user_id = ${user.userId} and revoked_at is null
                  and signing_key->>'x' = ${signing.x!} and signing_key->>'y' = ${signing.y!}`),
            );
            return { id: asId("device", existing!.id), added: false };
          }
          return { id, added: true };
        });
        if (enrolled.added) {
          await deps.host.announce(ctx.scope, [[DEVICES_TAG, enrolled.id]]);
        }
        return { id: enrolled.id };
      },
    }),
    startDeviceLink: defineAction({
      description:
        "Show this device's link code for 15 minutes, so a linked device can find it.",
      input: z.object({ device: z.string().min(1), code: linkCodeInput }),
      run: async ({ device, code }, ctx): Promise<{ readonly expiresAt: string }> => {
        const user = signedIn(ctx);
        const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
        const started = rowsOf<{ readonly id: string }>(
          await databaseOf(deps.host).transaction((handle) =>
            (handle as Database).execute(sql`
              update parlor_auth_devices set link_code = ${code}, link_expires_at = ${expiresAt}
              where id = ${device} and user_id = ${user.userId} and revoked_at is null
              returning id`),
          ),
        );
        if (started.length === 0)
          throw new ActionError("not_found", `No device ${device}`);
        return { expiresAt };
      },
    }),
    resolveDeviceLink: defineAction({
      description:
        "Find this account's device showing a link code, to check it and vouch for it.",
      input: z.union([
        z.object({ code: linkCodeInput }),
        z.object({ device: z.string().min(1).max(64) }),
      ]),
      run: async (input, ctx): Promise<PendingDevice> => {
        const user = signedIn(ctx);
        const found = await findPendingDevice(databaseOf(deps.host), user.userId, input);
        if (!found) {
          throw new ActionError(
            "not_found",
            "No device of yours shows this code. Check it, or show a new code on the device.",
          );
        }
        return found;
      },
    }),
    vouchDevice: defineAction({
      description:
        "Vouch, with this device's presence key, that a device showing a link code is the user's.",
      input: z.object({
        device: z.string().min(1),
        voucher: z.string().min(1),
        app: z.string().url(),
        commitment: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        at: z.number(),
        signature: deviceSignature,
      }),
      run: async (input, ctx): Promise<{ readonly id: string }> => {
        const user = signedIn(ctx);
        const voucher = await deps.registry.get(
          user.userId,
          asId("device", input.voucher),
        );
        if (!voucher?.presenceKey) {
          throw new ActionError(
            "forbidden",
            "Only a linked device that can confirm it is you can link another device.",
          );
        }
        const outcome = await verifyStatement(
          {
            statement: vouchStatement(
              input.app,
              input.voucher,
              input.device,
              input.commitment,
              input.at,
            ),
            deviceId: voucher.id,
            signature: input.signature as never,
          },
          {
            deviceId: voucher.id,
            signingKey: voucher.signingKey,
            presenceKey: voucher.presenceKey,
          },
          { requirePresence: true, now: Date.now(), maxAgeMs: VOUCH_MAX_AGE_MS },
        );
        if (outcome !== "valid") throw invalid("This confirmation did not check out.");
        const vouch: DeviceVouch = {
          voucher: voucher.id,
          commitment: input.commitment,
          at: input.at,
          signature: input.signature,
        };
        const vouched = rowsOf<{ readonly id: string }>(
          await databaseOf(deps.host).transaction((handle) =>
            (handle as Database).execute(sql`
              update parlor_auth_devices
              set vouches = vouches || ${JSON.stringify([vouch])}::jsonb,
                link_code = null, link_expires_at = null
              where id = ${input.device} and user_id = ${user.userId} and revoked_at is null
                and link_code is not null and link_expires_at > ${new Date().toISOString()}
              returning id`),
          ),
        );
        if (vouched.length === 0) {
          throw new ActionError(
            "not_found",
            "That device's code expired. Show a new code on it and try again.",
          );
        }
        await deps.host.announce(ctx.scope, [[DEVICES_TAG, input.device]]);
        return { id: input.device };
      },
    }),
    removeDevice: defineAction({
      description:
        "Remove a device, confirmed with this device's presence key; no computer accepts its signatures afterwards.",
      input: z.object({
        device: z.string().min(1),
        actor: z.string().min(1),
        app: z.string().url(),
        at: z.number(),
        signature: deviceSignature,
      }),
      run: async (input, ctx): Promise<{ readonly id: string }> => {
        const user = signedIn(ctx);
        const actor = await deps.registry.get(user.userId, asId("device", input.actor));
        if (!actor?.presenceKey) {
          throw new ActionError(
            "forbidden",
            "Only a linked device that can confirm it is you can remove a device.",
          );
        }
        const outcome = await verifyStatement(
          {
            statement: removeStatement(input.app, input.actor, input.device, input.at),
            deviceId: actor.id,
            signature: input.signature as never,
          },
          {
            deviceId: actor.id,
            signingKey: actor.signingKey,
            presenceKey: actor.presenceKey,
          },
          { requirePresence: true, now: Date.now(), maxAgeMs: VOUCH_MAX_AGE_MS },
        );
        if (outcome !== "valid") throw invalid("This confirmation did not check out.");
        const removed = rowsOf<{ readonly id: string }>(
          await databaseOf(deps.host).transaction((handle) =>
            (handle as Database).execute(sql`
              update parlor_auth_devices set revoked_at = now(), link_code = null
              where id = ${input.device} and user_id = ${user.userId} and revoked_at is null
              returning id`),
          ),
        );
        if (removed.length === 0) {
          throw new ActionError("not_found", `No device ${input.device}`);
        }
        await deps.host.announce(ctx.scope, [[DEVICES_TAG, input.device]]);
        return { id: input.device };
      },
    }),
    revokeDevice: defineAction({
      description:
        "Deprecated: use removeDevice, which a linked device confirms. Remove a device; no computer accepts its signatures afterwards.",
      input: z.object({ id: z.string().min(1) }),
      run: async ({ id }, ctx): Promise<{ readonly id: string }> => {
        const user = signedIn(ctx);
        const revoked = rowsOf<{ readonly id: string }>(
          await databaseOf(deps.host).transaction((handle) =>
            (handle as Database).execute(sql`
              update parlor_auth_devices set revoked_at = now()
              where id = ${id} and user_id = ${user.userId} and revoked_at is null
              returning id`),
          ),
        );
        if (revoked.length === 0) throw new ActionError("not_found", `No device ${id}`);
        await deps.host.announce(ctx.scope, [[DEVICES_TAG, id]]);
        return { id };
      },
    }),
  });
}

export type DeviceAccountActions = ActionsOf<ReturnType<typeof deviceAccountActions>>;
