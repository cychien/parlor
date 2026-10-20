import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { DataProvider } from "@parlor/core";
import type { Migration } from "@parlor/server";
import { sql } from "drizzle-orm";
import { exportJWK, generateKeyPair } from "jose";

import { type Database, jwkOf, rowsOf } from "./database.js";
import type { TurnTokenKeys } from "./tokens.js";

export const TURN_KEYS_MIGRATION: Migration = {
  id: "auth/0005_turn_keys",
  sql: `
    create table parlor_auth_turn_keys (
      kid text primary key,
      public_key jsonb not null,
      private_key text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create unique index parlor_auth_turn_keys_active on parlor_auth_turn_keys (active) where active`,
};

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const REFRESH_MIN_INTERVAL_MS = 1000;

interface KeyRow {
  readonly kid: string;
  readonly public_key: JsonWebKey | string;
  readonly private_key: string;
  readonly active: boolean;
}

function sealingKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", "parlor-auth/turn-keys", 32));
}

function seal(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function unseal(secret: string, sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !body) throw new Error("The sealed turn key is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export interface TurnKeyStore {
  keys(): Promise<TurnTokenKeys>;
  refresh(): Promise<TurnTokenKeys>;
}

export interface TurnKeyStoreOptions {
  readonly database: DataProvider;
  readonly issuer: string;
  readonly secret: () => Promise<string>;
  readonly now?: (() => number) | undefined;
}

export function createTurnKeyStore(options: TurnKeyStoreOptions): TurnKeyStore {
  const { database, issuer } = options;
  const now = options.now ?? Date.now;
  let loaded: Promise<TurnTokenKeys> | undefined;
  let refreshedAt = 0;

  const read = async (): Promise<KeyRow[]> =>
    rowsOf<KeyRow>(
      await (database.read() as Database).execute(
        sql`select kid, public_key, private_key, active from parlor_auth_turn_keys`,
      ),
    );

  const replace = async (secret: string, retiring: string | undefined): Promise<void> => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const publicKey = await exportJWK(pair.publicKey);
    const privateKey = await exportJWK(pair.privateKey);
    const kid = crypto.randomUUID();
    await database.transaction(async (tx) => {
      const db = tx as Database;
      if (retiring !== undefined) {
        await db.execute(
          sql`update parlor_auth_turn_keys set active = false where kid = ${retiring} and active`,
        );
      }
      await db.execute(sql`
        insert into parlor_auth_turn_keys (kid, public_key, private_key)
        values (${kid}, ${JSON.stringify(publicKey)}::jsonb, ${seal(secret, JSON.stringify(privateKey))})
        on conflict do nothing`);
    });
  };

  const signingKeyOf = async (
    secret: string,
    row: KeyRow,
  ): Promise<CryptoKey | undefined> => {
    try {
      return await crypto.subtle.importKey(
        "jwk",
        JSON.parse(unseal(secret, row.private_key)) as JsonWebKey,
        KEY_ALGORITHM,
        false,
        ["sign"],
      );
    } catch {
      return undefined;
    }
  };

  const build = async (mayReplace: boolean): Promise<TurnTokenKeys> => {
    const secret = await options.secret();
    let rows = await read();
    let active = rows.find((row) => row.active);
    let privateKey = active && (await signingKeyOf(secret, active));
    if (!privateKey && !mayReplace)
      throw new Error("The turn signing key cannot be opened.");
    if (!privateKey) {
      await replace(secret, active?.kid);
      rows = await read();
      active = rows.find((row) => row.active);
      privateKey = active && (await signingKeyOf(secret, active));
    }
    if (!active || !privateKey)
      throw new Error("The turn signing key could not be created.");
    const verifyKeys = await Promise.all(
      rows.map(async (row) => {
        const key = await crypto.subtle.importKey(
          "jwk",
          jwkOf(row.public_key),
          KEY_ALGORITHM,
          false,
          ["verify"],
        );
        return [row.kid, key] as const;
      }),
    );
    return { issuer, kid: active.kid, privateKey, publicKeys: new Map(verifyKeys) };
  };

  const load = (): Promise<TurnTokenKeys> => {
    loaded ??= build(true).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };

  return {
    keys: load,
    async refresh() {
      const current = await load();
      if (now() - refreshedAt < REFRESH_MIN_INTERVAL_MS) return current;
      refreshedAt = now();
      loaded = build(false).catch(() => current);
      return loaded;
    },
  };
}
