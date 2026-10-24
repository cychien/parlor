import type { HostPairing, PairingDevice } from "@parlor/capabilities";
import type { AnswerToSign, ItemSignature, PromptToSign } from "@parlor/chat";
import type { DeviceId } from "@parlor/core";

export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** `anonymous`: the server signs nobody in, so everyone uses the app without an account. */
export type SessionSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "anonymous" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly user: SessionUser };

/**
 * Who is signed in on this device, as the app's auth client sees it. `current` returns the
 * same object until the session changes.
 */
export interface SessionSource {
  current(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
}

/** This device's signing identity, as the chat needs it. */
export interface SessionDevice {
  readonly id: DeviceId;
  /** The public half of its keys, as the account registered them. */
  readonly keys: PairingDevice;
  signPrompt(prompt: PromptToSign): Promise<ItemSignature>;
  /** With `presence`, the platform asks for Touch ID, Face ID or a passkey first. */
  signAnswer(
    answer: AnswerToSign,
    options: { readonly presence: boolean },
  ): Promise<ItemSignature>;
}

export interface DeviceSource {
  /**
   * Enrolls this device with the account on first use; undefined where it cannot sign.
   * `presence: false` enrolls it without a presence key. Rejects with the capability's
   * `PresenceSetupCancelled` when the user dismisses the passkey prompt.
   */
  device(options?: { readonly presence?: boolean }): Promise<SessionDevice | undefined>;
  /** `needed` while the first `device()` would ask the user to create a passkey. */
  deviceSetup?(): Promise<"needed" | "ready">;
}

export interface HostAuthorizer {
  /** For pairing the host on this computer: a code for it, approved by this session. */
  authorizeHost(pairing: HostPairing): Promise<string>;
}

/** A device waiting to be linked, its keys checked against the code it shows. */
export interface PendingLink {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly commitment: string;
  /** The short code the device shows, for `parlor-host link` on the computer. */
  readonly code: string;
}

/** One of the account's devices, as the devices list shows it. */
export interface AccountDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  /** This device. */
  readonly current: boolean;
  readonly createdAt: string;
  readonly vouched: boolean;
  readonly linking: boolean;
  /** The device whose vouch linked it last. */
  readonly linkedBy?: string | undefined;
}

/** Thrown by `vouch` on a device with no presence key: the computer itself links it then. */
export class LinkOnComputer extends Error {
  override readonly name = "LinkOnComputer";
}

/** Linking devices: a new one shows a code, a linked one checks it and vouches for it. */
export interface DeviceLinker {
  /** Never prompts: a device not created yet reads as none. */
  linkState(): Promise<{
    readonly deviceId?: string | undefined;
    readonly vouched: boolean;
    /** It approved `connect` on the computer, so its first prompt links it. */
    readonly pairing: boolean;
  }>;
  /** Enrolls this device, with Face ID or Touch ID unless `presence` is false, and shows its code. */
  startLink(options?: { readonly presence?: boolean }): Promise<{
    readonly deviceId: string;
    readonly code: string;
    /** The whole hash the code is the start of; the QR carries it. */
    readonly commitment: string;
    readonly expiresAt: string;
  }>;
  /**
   * The device showing `code`, or the one whose QR named its id and whole commitment; throws
   * when the keys the app returns do not match.
   */
  resolveLink(
    from: string | { readonly deviceId: string; readonly commitment: string },
  ): Promise<PendingLink>;
  /** Vouches with this device's presence key; throws `LinkOnComputer` when it has none. */
  vouch(link: PendingLink): Promise<void>;
  /** Whether this device has a presence key to vouch with; never prompts. */
  canVouch(): Promise<boolean>;
  listDevices(): Promise<readonly AccountDevice[]>;
  /** Removes a device, confirmed with Face ID or Touch ID; throws `LinkOnComputer` without them. */
  removeDevice(id: string): Promise<void>;
}

/** What `FrameworkProvider` takes as `auth`; signing, host pairing and linking are optional. */
export type FrameworkAuth = SessionSource &
  Partial<DeviceSource & HostAuthorizer & DeviceLinker>;
