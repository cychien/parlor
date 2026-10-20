import type { CapabilityAdapter } from "../capability.js";
import type { DeviceKey } from "./interface.js";

export interface WebDeviceKeyApis {
  readonly subtle: SubtleCrypto | undefined;
  readonly indexedDB: IDBFactory | undefined;
  readonly credentials: CredentialsContainer | undefined;
}

/**
 * Signing key: a non-extractable ECDSA P-256 `CryptoKey` in IndexedDB. Presence key: a
 * platform passkey whose assertion challenge is the payload's SHA-256.
 */
export function webDeviceKey(
  apis: () => WebDeviceKeyApis = () => ({
    subtle: globalThis.crypto?.subtle,
    indexedDB: globalThis.indexedDB,
    credentials: globalThis.navigator?.credentials,
  }),
): CapabilityAdapter<DeviceKey> {
  return {
    platform: "web",
    available: () => {
      // TODO: subtle and indexedDB both present.
      void apis;
      throw new Error("not implemented");
    },
    create: () => {
      // TODO: load or generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
      //   in a "parlor-device" store; presence via credentials.create/get with
      //   userVerification "required". Without credentials, publicKeys() omits `presence`
      //   and a presence signing rejects.
      throw new Error("not implemented");
    },
  };
}
