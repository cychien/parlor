import type { HostPairing } from "@parlor/capabilities";
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
  signPrompt(prompt: PromptToSign): Promise<ItemSignature>;
  /** With `presence`, the platform asks for Touch ID, Face ID or a passkey first. */
  signAnswer(
    answer: AnswerToSign,
    options: { readonly presence: boolean },
  ): Promise<ItemSignature>;
}

export interface DeviceSource {
  /** Enrolls this device with the account on first use; undefined where it cannot sign. */
  device(): Promise<SessionDevice | undefined>;
}

export interface HostAuthorizer {
  /** For pairing the host on this computer: a code for it, approved by this session. */
  authorizeHost(pairing: HostPairing): Promise<string>;
}

/** What `FrameworkProvider` takes as `auth`; signing and host pairing are optional. */
export type FrameworkAuth = SessionSource & Partial<DeviceSource & HostAuthorizer>;
