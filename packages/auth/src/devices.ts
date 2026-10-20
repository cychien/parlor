import {
  defineAction,
  type DataProvider,
  type DeviceId,
  type UserId,
} from "@parlor/core";
import { type ActionsOf, createRegistry } from "@parlor/core/registry";
import type { DeviceKeys, Migration, PluginHost } from "@parlor/server";
import { z } from "zod";

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

export function createDeviceRegistry(database: DataProvider): DeviceRegistry {
  void database;
  throw new Error("not implemented");
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

const jwk = z.record(z.string(), z.unknown());

const deviceSignature = z.object({
  keyId: z.string(),
  presence: z.enum(["none", "user"]),
  format: z.enum(["es256-raw", "webauthn"]),
  signature: z.string(),
  authenticatorData: z.string().optional(),
  clientDataJSON: z.string().optional(),
});

export interface DeviceActionDeps {
  readonly host: PluginHost;
  readonly registry: DeviceRegistry;
}

/** `devices`, `enrollDevice` and `revokeDevice`, merged into the account actions in phase 5. */
export function deviceAccountActions(deps: DeviceActionDeps) {
  const notImplemented = (): never => {
    void deps;
    throw new Error("not implemented");
  };
  return createRegistry({
    devices: defineAction({
      description: "List the devices that sign this account's chat messages.",
      input: z.object({}),
      reads: [DEVICES_TAG],
      run: (): ConnectedDevice[] => notImplemented(),
    }),
    deviceChallenge: defineAction({
      description: "A single-use challenge for enrolling this device.",
      input: z.object({}),
      run: (): { readonly challenge: string } => notImplemented(),
    }),
    enrollDevice: defineAction({
      description: "Register this device's public keys, proven by signing a challenge.",
      input: z.object({
        name: z.string().min(1).max(80),
        platform: z.string().min(1).max(32),
        challenge: z.string().min(1),
        signing: z.object({ keyId: z.string().min(1), publicKey: jwk }),
        presence: z
          .discriminatedUnion("format", [
            z.object({
              format: z.literal("webauthn"),
              credentialId: z.string().min(1),
              publicKey: jwk,
              attestation: z.string().min(1),
            }),
            z.object({
              format: z.literal("es256-raw"),
              keyId: z.string().min(1),
              publicKey: jwk,
            }),
          ])
          .optional(),
        proof: deviceSignature,
      }),
      // TODO: consume the challenge; verify proof with signing.publicKey; verify a webauthn
      //   attestation once; insert; announce [[DEVICES_TAG, id]]; answer the id.
      run: (): { readonly id: DeviceId } => notImplemented(),
    }),
    revokeDevice: defineAction({
      description: "Remove a device; no computer accepts its signatures afterwards.",
      input: z.object({ id: z.string().min(1) }),
      run: (): { readonly id: string } => notImplemented(),
    }),
  });
}

export type DeviceAccountActions = ActionsOf<ReturnType<typeof deviceAccountActions>>;
