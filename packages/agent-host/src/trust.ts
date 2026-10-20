import type { PinnedDevice } from "@parlor/auth";

/** A device this computer accepts prompts from, its keys pinned at approval. */
export interface TrustedDevice extends PinnedDevice {
  readonly name: string;
  readonly platform: string;
  readonly approvedAt: number;
  readonly via: "pairing" | "local";
}

/** Local state the backend cannot write. */
export interface TrustStore {
  get(appOrigin: string, deviceId: string): Promise<TrustedDevice | undefined>;
  pin(appOrigin: string, device: TrustedDevice): Promise<void>;
  forget(appOrigin: string, deviceId?: string): Promise<void>;
}

/** `~/.parlor/host/trust.json`, 0600, written atomically. */
export function fileTrustStore(file: string): TrustStore {
  void file;
  throw new Error("not implemented");
}
