/**
 * A device's signing identity; its private keys never leave the platform keystore. The
 * signing key signs prompts with no user present. The presence key signs answers to an
 * agent's own permission prompts and always needs Touch ID, Face ID or a passkey.
 */
export interface DeviceKey {
  /**
   * Creates the keys on first use; stable afterwards. `presence: false` settles this device
   * without a presence key. Throws `PresenceSetupCancelled`, keeping nothing, when the user
   * dismisses the platform's prompt, so a later call can ask again.
   */
  publicKeys(
    enrollment: PresenceEnrollment,
    options?: { readonly presence?: boolean },
  ): Promise<DevicePublicKeys>;
  /**
   * `needed` while the next `publicKeys` would show a platform prompt (a passkey on the web),
   * so the app can explain it first. Absent where creating the keys never prompts.
   */
  presenceSetup?(): Promise<"needed" | "done">;
  sign(
    payload: Uint8Array,
    options: { readonly presence: false },
  ): Promise<DeviceSignature>;
  sign(
    payload: Uint8Array,
    options: { readonly presence: true },
  ): Promise<PresenceSignature>;
}

export class PresenceSetupCancelled extends Error {
  override readonly name = "PresenceSetupCancelled";
  constructor() {
    super("The passkey was not created.");
  }
}

export interface PresenceEnrollment {
  readonly rpId: string;
  readonly userId: string;
  readonly userName: string;
  /** Server-issued, single use; the proof of possession signs it. */
  readonly challenge: Uint8Array;
}

export interface DevicePublicKeys {
  readonly signing: { readonly keyId: string; readonly publicKey: JsonWebKey };
  /** Absent where the platform has no presence authenticator. */
  readonly presence?: PresencePublicKey | undefined;
  readonly proof: DeviceSignature;
}

export type PresencePublicKey =
  | {
      readonly format: "webauthn";
      readonly credentialId: string;
      readonly publicKey: JsonWebKey;
      /** The attestation object, verified by the server once at enrollment. */
      readonly attestation: string;
    }
  | {
      readonly format: "es256-raw";
      readonly keyId: string;
      readonly publicKey: JsonWebKey;
    };

export interface DeviceSignature {
  readonly keyId: string;
  readonly presence: "none" | "user";
  readonly format: "es256-raw" | "webauthn";
  /** base64url */
  readonly signature: string;
  readonly authenticatorData?: string | undefined;
  readonly clientDataJSON?: string | undefined;
}

declare const presenceBrand: unique symbol;

/** Only `sign(..., { presence: true })` produces one, so an ordinary signature never passes for it. */
export type PresenceSignature = DeviceSignature & {
  readonly presence: "user";
  readonly [presenceBrand]: true;
};
