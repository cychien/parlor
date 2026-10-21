import { detectPlatform } from "../runtime.js";
import { encodeBase64url } from "./encoding.js";
import type {
  DeviceKey,
  DevicePublicKeys,
  DeviceSignature,
  PresenceSignature,
} from "./interface.js";

export interface NativePublicKeys {
  readonly signing: { readonly keyId: string; readonly publicKey: JsonWebKey };
  readonly presence?: { readonly keyId: string; readonly publicKey: JsonWebKey };
  readonly proof: { readonly signature: string };
}

export interface NativeKeystore {
  publicKeys(options: {
    readonly presence: boolean;
    readonly challenge: string;
  }): Promise<NativePublicKeys>;
  sign(options: {
    readonly keyId: string;
    readonly payload: string;
  }): Promise<{ readonly signature: string }>;
}

export function nativeDeviceKey(keystore: NativeKeystore): DeviceKey {
  let known: Promise<NativePublicKeys> | undefined;
  const keysOf = () => (known ??= keystore.publicKeys({ presence: true, challenge: "" }));

  const signature = async (
    keyId: string,
    presence: "none" | "user",
    payload: Uint8Array,
  ): Promise<DeviceSignature> => ({
    keyId,
    presence,
    format: "es256-raw",
    signature: (await keystore.sign({ keyId, payload: encodeBase64url(payload) }))
      .signature,
  });

  async function sign(
    payload: Uint8Array,
    options: { readonly presence: false },
  ): Promise<DeviceSignature>;
  async function sign(
    payload: Uint8Array,
    options: { readonly presence: true },
  ): Promise<PresenceSignature>;
  async function sign(payload: Uint8Array, options: { readonly presence: boolean }) {
    const keys = await keysOf();
    if (!options.presence) return signature(keys.signing.keyId, "none", payload);
    if (!keys.presence) throw new Error("This device has no presence key.");
    return (await signature(keys.presence.keyId, "user", payload)) as PresenceSignature;
  }

  return {
    async publicKeys(enrollment): Promise<DevicePublicKeys> {
      const pending = keystore.publicKeys({
        presence: true,
        challenge: encodeBase64url(enrollment.challenge),
      });
      known = pending;
      const keys = await pending;
      return {
        signing: keys.signing,
        presence: keys.presence && {
          format: "es256-raw",
          keyId: keys.presence.keyId,
          publicKey: keys.presence.publicKey,
        },
        proof: {
          keyId: keys.signing.keyId,
          presence: "none",
          format: "es256-raw",
          signature: keys.proof.signature,
        },
      };
    },
    sign,
  };
}

interface Invoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const UNAVAILABLE = /not found|unsupported/i;

/**
 * Whether the shell carries a working native command: one an older generated project lacks
 * ("not found") or a platform without a keystore refuses ("unsupported") is unavailable.
 */
export async function hasNativeCommand(
  load: () => Promise<Invoker>,
  command: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  if (detectPlatform() !== "tauri") return false;
  try {
    await (await load()).invoke(command, args);
    return true;
  } catch (error) {
    return !UNAVAILABLE.test(error instanceof Error ? error.message : String(error));
  }
}

export function hasIosPlugin(): boolean {
  const { Capacitor } = globalThis as { Capacitor?: { getPlatform?: () => string } };
  return detectPlatform() === "capacitor" && Capacitor?.getPlatform?.() === "ios";
}
