import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { AccountSummary } from "@parlor/auth";
import type { GrantId, HostId } from "@parlor/core";

import { hostAssertion } from "./assertion.js";
import { jsonFile } from "./json-file.js";

/** One app this computer is connected to. Its key lives in `HostKeys`, never here. */
export interface AppGrant {
  readonly appOrigin: string;
  readonly appName: string;
  readonly grantId: GrantId;
  readonly hostId: HostId;
  readonly account: AccountSummary;
  /** The agents' working directory for this app; only the user changes it, here. */
  readonly workspace: string;
  readonly createdAt: number;
  /** A `parlor dev` grant: in memory only. */
  readonly dev?: true | undefined;
  /** Refused here but not yet revoked by the app: kept only to retry the revoke, never served. */
  readonly declined?: true | undefined;
  /**
   * Handed only to the browser that approved `connect`, through the loopback redirect; that
   * browser proves it on its first prompt and is trusted without asking, then this is dropped.
   */
  readonly pairingSecret?: string | undefined;
  /**
   * Whether the coding agents on this computer may use the app outside its sidebar, as the
   * user chose when connecting, and the name and agents it is registered under once it is.
   */
  readonly agentTools?:
    | {
        readonly on: boolean;
        readonly name?: string | undefined;
        readonly agents?: readonly string[] | undefined;
      }
    | undefined;
}

/** One key per app grant in the OS keychain; the server holds only its public half. */
export interface HostKeys {
  /** A pairing's new key pair, kept only once the pairing completes. */
  create(appOrigin: string): Promise<HostKeyPair>;
  /** A fresh `ParlorHost` assertion for one request. */
  assert(
    appOrigin: string,
    request: { readonly method: "GET" | "POST"; readonly url: string },
  ): Promise<string>;
  remove(appOrigin: string): Promise<void>;
}

export interface HostKeyPair {
  readonly publicKey: JsonWebKey;
  /** RFC 7638, the assertion's `kid`. */
  readonly thumbprint: string;
  sign(payload: Uint8Array): Promise<string>;
  /** Binds the key to the grant the pairing produced and stores it. */
  keep(grantId: GrantId): Promise<void>;
}

export interface GrantStore {
  list(): Promise<readonly AppGrant[]>;
  get(appOrigin: string): Promise<AppGrant | undefined>;
  save(grant: AppGrant): Promise<void>;
  remove(appOrigin: string): Promise<void>;
}

/** `~/.parlor/host/grants.json`, 0600, written atomically. */
export function fileGrantStore(file: string): GrantStore {
  const grants = jsonFile<Record<string, AppGrant>>(file);
  return {
    list: async () => Object.values(await grants.read()),
    get: async (appOrigin) => (await grants.read())[appOrigin],
    save: (grant) =>
      grants.change((all) => {
        all[grant.appOrigin] = grant;
      }),
    remove: (appOrigin) =>
      grants.change((all) => {
        delete all[appOrigin];
      }),
  };
}

const EC_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

interface StoredKey {
  readonly jwk: JsonWebKey;
  readonly kid: string;
  readonly grantId: string;
}

interface LoadedKey {
  readonly key: CryptoKey;
  readonly kid: string;
  readonly grantId: string;
}

interface SecretStore {
  read(account: string): Promise<string | undefined>;
  write(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

function thumbprintOf({ crv, kty, x, y }: JsonWebKey): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv, kty, x, y }))
    .digest("base64url");
}

const signer = (key: CryptoKey) => async (payload: Uint8Array) =>
  Buffer.from(await crypto.subtle.sign(ES256, key, new Uint8Array(payload))).toString(
    "base64url",
  );

function keysIn(secrets: SecretStore): HostKeys {
  const loaded = new Map<string, Promise<LoadedKey | undefined>>();
  const load = (appOrigin: string) => {
    let entry = loaded.get(appOrigin);
    if (!entry) {
      entry = (async () => {
        const secret = await secrets.read(appOrigin);
        if (secret === undefined) return undefined;
        const stored = JSON.parse(
          Buffer.from(secret, "base64url").toString("utf8"),
        ) as StoredKey;
        const key = await crypto.subtle.importKey("jwk", stored.jwk, EC_P256, false, [
          "sign",
        ]);
        return { key, kid: stored.kid, grantId: stored.grantId };
      })();
      entry.catch(() => loaded.delete(appOrigin));
      loaded.set(appOrigin, entry);
    }
    return entry;
  };
  return {
    async create(appOrigin) {
      const pair = await crypto.subtle.generateKey(EC_P256, true, ["sign", "verify"]);
      const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const publicKey: JsonWebKey = {
        kty: exported.kty!,
        crv: exported.crv!,
        x: exported.x!,
        y: exported.y!,
      };
      const thumbprint = thumbprintOf(publicKey);
      return {
        publicKey,
        thumbprint,
        sign: signer(pair.privateKey),
        keep: async (grantId) => {
          const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
          const stored: StoredKey = { jwk, kid: thumbprint, grantId };
          await secrets.write(
            appOrigin,
            Buffer.from(JSON.stringify(stored)).toString("base64url"),
          );
          loaded.delete(appOrigin);
        },
      };
    },
    async assert(appOrigin, request) {
      const key = await load(appOrigin);
      if (!key) throw new Error(`This computer holds no key for ${appOrigin}.`);
      return hostAssertion(signer(key.key), key, request);
    },
    async remove(appOrigin) {
      loaded.delete(appOrigin);
      await secrets.remove(appOrigin);
    },
  };
}

const run = promisify(execFile);
const NOT_FOUND = 44;

function macKeychain(service: string): SecretStore {
  const checked = (account: string) => {
    if (!ORIGIN.test(account)) throw new Error(`${account} is not an app origin.`);
    return account;
  };
  return {
    async read(account) {
      try {
        const { stdout } = await run("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          checked(account),
          "-w",
        ]);
        return stdout.trim();
      } catch (error) {
        if ((error as { code?: unknown }).code === NOT_FOUND) return undefined;
        throw error;
      }
    },
    async write(account, secret) {
      // Through `security -i` on stdin, so the private key never shows in a process list.
      const command = `add-generic-password -U -s ${service} -a ${checked(account)} -w ${secret}\n`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 && stderr.trim() === ""
            ? resolve()
            : reject(new Error(`The Keychain refused the key: ${stderr.trim() || code}`)),
        );
        child.stdin.end(command);
      });
      if ((await this.read(account)) !== secret) {
        throw new Error("The Keychain did not keep the key.");
      }
    },
    async remove(account) {
      try {
        await run("security", [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          checked(account),
        ]);
      } catch (error) {
        if ((error as { code?: unknown }).code !== NOT_FOUND) throw error;
      }
    },
  };
}

/** The macOS Keychain; other platforms are refused before pairing (`unsupportedHostPlatform`). */
export function keychainHostKeys(service: string): HostKeys {
  return keysIn(macKeychain(service));
}

/** For `parlor-host dev`: one dev host token for every request, nothing on disk. */
export function devHostKeys(hostToken: string): HostKeys {
  return {
    create: () => Promise.reject(new Error("A parlor dev server needs no pairing.")),
    assert: async () => hostToken,
    remove: async () => undefined,
  };
}
