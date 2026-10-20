import type {
  DeviceKey,
  DevicePublicKeys,
  DeviceSignature,
  PresenceEnrollment,
  PresencePublicKey,
  PresenceSignature,
} from "@parlor/capabilities";
import {
  decodeBase64url,
  encodeBase64url,
  enrollmentBytes,
} from "@parlor/capabilities/encoding";

import type { Browser } from "./app.js";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

const generate = () => crypto.subtle.generateKey(P256, true, ["sign", "verify"]);

const point = async (key: CryptoKey): Promise<JsonWebKey> => {
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", key);
  return { kty: kty!, crv: crv!, x: x!, y: y! };
};

const idOf = async (key: JsonWebKey) =>
  encodeBase64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }),
        ),
      ),
    ),
  );

export class TestDeviceKey implements DeviceKey {
  readonly #signing = generate();
  readonly #presence: Promise<CryptoKeyPair> | undefined;

  constructor(withPresence = true) {
    this.#presence = withPresence ? generate() : undefined;
  }

  async publicKeys(enrollment: PresenceEnrollment): Promise<DevicePublicKeys> {
    const signing = await point((await this.#signing).publicKey);
    const presence: PresencePublicKey | undefined = this.#presence
      ? await (async () => {
          const publicKey = await point((await this.#presence!).publicKey);
          return {
            format: "es256-raw" as const,
            keyId: await idOf(publicKey),
            publicKey,
          };
        })()
      : undefined;
    return {
      signing: { keyId: await idOf(signing), publicKey: signing },
      presence,
      proof: await this.#raw(
        (await this.#signing).privateKey,
        await idOf(signing),
        "none",
        enrollmentBytes({ challenge: enrollment.challenge, signing, presence }),
      ),
    };
  }

  async #raw(
    key: CryptoKey,
    keyId: string,
    presence: "none" | "user",
    payload: Uint8Array,
  ): Promise<DeviceSignature> {
    const signature = await crypto.subtle.sign(ES256, key, new Uint8Array(payload));
    return {
      keyId,
      presence,
      format: "es256-raw",
      signature: encodeBase64url(new Uint8Array(signature)),
    };
  }

  sign(
    payload: Uint8Array,
    options: { readonly presence: false },
  ): Promise<DeviceSignature>;
  sign(
    payload: Uint8Array,
    options: { readonly presence: true },
  ): Promise<PresenceSignature>;
  async sign(payload: Uint8Array, options: { readonly presence: boolean }) {
    if (!options.presence) {
      const pair = await this.#signing;
      return this.#raw(
        pair.privateKey,
        await idOf(await point(pair.publicKey)),
        "none",
        payload,
      );
    }
    if (!this.#presence) throw new Error("This device has no presence key.");
    const pair = await this.#presence;
    return (await this.#raw(
      pair.privateKey,
      await idOf(await point(pair.publicKey)),
      "user",
      payload,
    )) as PresenceSignature;
  }
}

export async function enroll(
  browser: Browser,
  device: TestDeviceKey,
  tweak: (input: Record<string, any>) => void = () => {},
) {
  const { challenge } = (await browser.account("deviceChallenge")).body.data;
  const keys = await device.publicKeys({
    rpId: "hello.example",
    userId: "u",
    userName: "u",
    challenge: decodeBase64url(challenge),
  });
  const input: Record<string, any> = {
    name: "Chrome on macOS",
    platform: "web",
    challenge,
    signing: keys.signing,
    ...(keys.presence ? { presence: keys.presence } : {}),
    proof: keys.proof,
  };
  tweak(input);
  return browser.account("enrollDevice", input);
}
