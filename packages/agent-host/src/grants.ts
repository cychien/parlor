import type { AccountSummary } from "@parlor/auth";
import type { GrantId, HostId } from "@parlor/core";

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
  keep(): Promise<void>;
}

export interface GrantStore {
  list(): Promise<readonly AppGrant[]>;
  get(appOrigin: string): Promise<AppGrant | undefined>;
  save(grant: AppGrant): Promise<void>;
  remove(appOrigin: string): Promise<void>;
}

/** `~/.parlor/host/grants.json`, 0600, written atomically. */
export function fileGrantStore(file: string): GrantStore {
  void file;
  throw new Error("not implemented");
}

/** macOS Keychain, libsecret or Windows Credential Manager. */
export function keychainHostKeys(service: string): HostKeys {
  void service;
  throw new Error("not implemented");
}

/** For `parlor-host dev`: one dev host token for every request, nothing on disk. */
export function devHostKeys(hostToken: string): HostKeys {
  void hostToken;
  throw new Error("not implemented");
}
