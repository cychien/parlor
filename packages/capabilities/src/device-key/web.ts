import type { CapabilityAdapter } from "../capability.js";
import {
  decodeBase64url,
  encodeBase64url,
  enrollmentBytes,
  publicPoint,
} from "./encoding.js";
import {
  type DeviceKey,
  type DevicePublicKeys,
  type DeviceSignature,
  type PresenceEnrollment,
  type PresencePublicKey,
  PresenceSetupCancelled,
  type PresenceSignature,
} from "./interface.js";

export interface WebDeviceKeyApis {
  readonly subtle: SubtleCrypto | undefined;
  readonly indexedDB: IDBFactory | undefined;
  readonly credentials: CredentialsContainer | undefined;
  /** Whether a platform authenticator (Touch ID, Windows Hello) can make the passkey. */
  readonly platformAuthenticator?: (() => Promise<boolean>) | undefined;
}

const hasPlatformAuthenticator = async (): Promise<boolean> => {
  try {
    return (
      (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ??
      false
    );
  } catch {
    return false;
  }
};

const DATABASE = "parlor";
const STORE = "parlor-device";
const SIGNING = "signing";
const PRESENCE = "presence";
const CEREMONY_TIMEOUT_MS = 60_000;
const COSE_ES256 = -7;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

type StoredPresence =
  | {
      readonly credentialId: string;
      readonly rpId: string;
      readonly publicKey: JsonWebKey;
      readonly attestation: string;
    }
  | { readonly unavailable: true };

interface KeyStore {
  read<T>(key: string): Promise<T | undefined>;
  keepFirst<T>(key: string, value: T): Promise<T>;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openKeyStore(factory: IDBFactory): KeyStore {
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => void request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    async read<T>(key: string) {
      const tx = (await database).transaction(STORE, "readonly");
      return (await settled(tx.objectStore(STORE).get(key))) as T | undefined;
    },
    async keepFirst<T>(key: string, value: T) {
      const tx = (await database).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const existing = (await settled(store.get(key))) as T | undefined;
      if (existing !== undefined) return existing;
      await settled(store.put(value, key));
      return value;
    },
  };
}

const isPublicKeyCredential = (
  credential: Credential | null,
): credential is PublicKeyCredential => credential?.type === "public-key";

const isAttestation = (
  response: AuthenticatorResponse,
): response is AuthenticatorAttestationResponse => "attestationObject" in response;

const isAssertion = (
  response: AuthenticatorResponse,
): response is AuthenticatorAssertionResponse => "signature" in response;

const NO_PRESENCE: StoredPresence = { unavailable: true };

function createWebDeviceKey(
  subtle: SubtleCrypto,
  factory: IDBFactory,
  credentials: CredentialsContainer | undefined,
  platformAuthenticator: () => Promise<boolean>,
): DeviceKey {
  const store = openKeyStore(factory);

  const thumbprint = async (key: JsonWebKey) => {
    const { crv, kty, x, y } = key;
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ crv, kty, x, y })),
    );
    return encodeBase64url(new Uint8Array(digest));
  };

  const signingIdentity = async () => {
    const stored = await store.read<CryptoKeyPair>(SIGNING);
    const pair =
      stored ??
      (await store.keepFirst<CryptoKeyPair>(
        SIGNING,
        await subtle.generateKey(P256, false, ["sign", "verify"]),
      ));
    const publicKey = publicPoint(await subtle.exportKey("jwk", pair.publicKey));
    return { privateKey: pair.privateKey, publicKey, keyId: await thumbprint(publicKey) };
  };

  const signRaw = async (payload: Uint8Array): Promise<DeviceSignature> => {
    const { privateKey, keyId } = await signingIdentity();
    const signature = await subtle.sign(ES256, privateKey, new Uint8Array(payload));
    return {
      keyId,
      presence: "none",
      format: "es256-raw",
      signature: encodeBase64url(new Uint8Array(signature)),
    };
  };

  const createPresence = async (
    container: CredentialsContainer,
    enrollment: PresenceEnrollment,
  ): Promise<StoredPresence> => {
    try {
      const credential = await container.create({
        publicKey: {
          rp: { id: enrollment.rpId, name: enrollment.rpId },
          user: {
            id: new TextEncoder().encode(enrollment.userId),
            name: enrollment.userName,
            displayName: enrollment.userName,
          },
          challenge: new Uint8Array(enrollment.challenge),
          pubKeyCredParams: [{ type: "public-key", alg: COSE_ES256 }],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "preferred",
            userVerification: "required",
          },
          attestation: "none",
          timeout: CEREMONY_TIMEOUT_MS,
        },
      });
      if (!isPublicKeyCredential(credential) || !isAttestation(credential.response)) {
        return { unavailable: true };
      }
      const spki = credential.response.getPublicKey();
      if (spki === null) return { unavailable: true };
      const key = await subtle.importKey("spki", spki, P256, true, ["verify"]);
      return {
        credentialId: encodeBase64url(new Uint8Array(credential.rawId)),
        rpId: enrollment.rpId,
        publicKey: publicPoint(await subtle.exportKey("jwk", key)),
        attestation: encodeBase64url(
          new Uint8Array(credential.response.attestationObject),
        ),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "NotAllowedError") {
        throw new PresenceSetupCancelled();
      }
      return NO_PRESENCE;
    }
  };

  const canCreatePresence = async () =>
    credentials !== undefined && (await platformAuthenticator());

  const presenceOf = async (
    enrollment: PresenceEnrollment,
    wanted: boolean,
  ): Promise<PresencePublicKey | undefined> => {
    const stored =
      (await store.read<StoredPresence>(PRESENCE)) ??
      (await store.keepFirst(
        PRESENCE,
        credentials && wanted && (await canCreatePresence())
          ? await createPresence(credentials, enrollment)
          : NO_PRESENCE,
      ));
    if ("unavailable" in stored) return undefined;
    return {
      format: "webauthn",
      credentialId: stored.credentialId,
      publicKey: stored.publicKey,
      attestation: stored.attestation,
    };
  };

  const signPresence = async (payload: Uint8Array): Promise<PresenceSignature> => {
    const stored = await store.read<StoredPresence>(PRESENCE);
    if (!credentials || !stored || "unavailable" in stored) {
      throw new Error("This device has no presence key.");
    }
    const challenge = new Uint8Array(
      await subtle.digest("SHA-256", new Uint8Array(payload)),
    );
    const assertion = await credentials.get({
      publicKey: {
        challenge,
        rpId: stored.rpId,
        allowCredentials: [
          { type: "public-key", id: decodeBase64url(stored.credentialId) },
        ],
        userVerification: "required",
        timeout: CEREMONY_TIMEOUT_MS,
      },
    });
    if (!isPublicKeyCredential(assertion) || !isAssertion(assertion.response)) {
      throw new Error("The presence check did not complete.");
    }
    const { authenticatorData, clientDataJSON, signature } = assertion.response;
    return {
      keyId: stored.credentialId,
      presence: "user",
      format: "webauthn",
      signature: encodeBase64url(new Uint8Array(signature)),
      authenticatorData: encodeBase64url(new Uint8Array(authenticatorData)),
      clientDataJSON: encodeBase64url(new Uint8Array(clientDataJSON)),
    } as PresenceSignature;
  };

  async function sign(
    payload: Uint8Array,
    options: { readonly presence: false },
  ): Promise<DeviceSignature>;
  async function sign(
    payload: Uint8Array,
    options: { readonly presence: true },
  ): Promise<PresenceSignature>;
  async function sign(payload: Uint8Array, options: { readonly presence: boolean }) {
    return options.presence ? signPresence(payload) : signRaw(payload);
  }

  return {
    async publicKeys(enrollment, options): Promise<DevicePublicKeys> {
      const { publicKey, keyId } = await signingIdentity();
      const presence = await presenceOf(enrollment, options?.presence ?? true);
      return {
        signing: { keyId, publicKey },
        presence,
        proof: await signRaw(
          enrollmentBytes({
            challenge: enrollment.challenge,
            signing: publicKey,
            presence,
          }),
        ),
      };
    },
    sign,
    async presenceSetup() {
      if (await store.read<StoredPresence>(PRESENCE)) return "done";
      return (await canCreatePresence()) ? "needed" : "done";
    },
  };
}

export function webDeviceKey(
  apis: () => WebDeviceKeyApis = () => ({
    subtle: globalThis.crypto?.subtle,
    indexedDB: globalThis.indexedDB,
    credentials: globalThis.navigator?.credentials,
    platformAuthenticator: hasPlatformAuthenticator,
  }),
): CapabilityAdapter<DeviceKey> {
  return {
    platform: "web",
    available: () => {
      const { subtle, indexedDB } = apis();
      return subtle !== undefined && indexedDB !== undefined;
    },
    create: () => {
      const { subtle, indexedDB, credentials, platformAuthenticator } = apis();
      if (!subtle || !indexedDB) {
        throw new Error("This browser cannot keep a device key.");
      }
      return createWebDeviceKey(
        subtle,
        indexedDB,
        credentials,
        platformAuthenticator ?? hasPlatformAuthenticator,
      );
    },
  };
}
