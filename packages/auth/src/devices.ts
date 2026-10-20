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
import type { DeviceKeys, Migration, PluginHost, PresenceKey } from "@parlor/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { signedIn } from "./account.js";
import { type Database, jwkOf, rowsOf } from "./database.js";
import { verifyEs256 } from "./es256.js";

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
}

export function createDeviceRegistry(database: DataProvider): DeviceRegistry {
  return {
    async get(userId, deviceId) {
      const [row] = rowsOf<DeviceRow>(
        await (database.read() as Database).execute(sql`
          select id, user_id, name, platform, signing_key, presence_key,
            (extract(epoch from created_at) * 1000)::bigint as created_ms
          from parlor_auth_devices
          where id = ${deviceId} and user_id = ${userId} and revoked_at is null`),
      );
      if (!row) return undefined;
      const presence =
        typeof row.presence_key === "string"
          ? (JSON.parse(row.presence_key) as PresenceKey)
          : row.presence_key;
      return {
        id: asId("device", row.id),
        userId: asId("user", row.user_id),
        name: row.name,
        platform: row.platform,
        signingKey: jwkOf(row.signing_key),
        presenceKey: presence ?? undefined,
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

    create table parlor_auth_device_challenges (
      challenge text primary key,
      user_id text not null,
      expires_at timestamptz not null
    )`,
};

export interface ConnectedDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly platform: string;
  readonly current: boolean;
  readonly createdAt: string;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
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
            select id, name, platform, created_at from parlor_auth_devices
            where user_id = ${user.userId} and revoked_at is null order by created_at, id`),
        );
        return rows.map((row) => ({
          id: asId("device", row.id),
          name: row.name,
          platform: row.platform,
          current: row.id === user.deviceId,
          createdAt: isoOf(row.created_at),
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
          const [existing] = rowsOf<{ readonly id: string }>(
            await tx.execute(sql`
              select id from parlor_auth_devices
              where user_id = ${user.userId} and revoked_at is null
                and signing_key->>'x' = ${signing.x!} and signing_key->>'y' = ${signing.y!}`),
          );
          if (existing) return { id: asId("device", existing.id), added: false };
          const id = asId("device", randomBytes(16).toString("base64url"));
          await tx.execute(sql`
            insert into parlor_auth_devices (id, user_id, name, platform, signing_key, presence_key)
            values (${id}, ${user.userId}, ${input.name}, ${input.platform},
              ${JSON.stringify(signing)}::jsonb,
              ${presence ? JSON.stringify(presence.stored) : null}::jsonb)`);
          return { id, added: true };
        });
        if (enrolled.added) {
          await deps.host.announce(ctx.scope, [[DEVICES_TAG, enrolled.id]]);
        }
        return { id: enrolled.id };
      },
    }),
    revokeDevice: defineAction({
      description: "Remove a device; no computer accepts its signatures afterwards.",
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
