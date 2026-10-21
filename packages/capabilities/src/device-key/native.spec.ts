import { describe, expect, it } from "vitest";

import { decodeBase64url, enrollmentBytes } from "./encoding.js";
import { nativeDeviceKey } from "./native.js";
import { fakeKeystore } from "./spec-kit.js";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

async function verifies(key: JsonWebKey, signature: string, payload: Uint8Array) {
  const imported = await crypto.subtle.importKey("jwk", key, P256, false, ["verify"]);
  return crypto.subtle.verify(
    ES256,
    imported,
    decodeBase64url(signature),
    new Uint8Array(payload),
  );
}

const enrollment = (challenge = new Uint8Array([1, 2, 3])) => ({
  rpId: "hello.example",
  userId: "user-1",
  userName: "alice@example.com",
  challenge,
});

describe("nativeDeviceKey", () => {
  it("hands the native side the base64url challenge and returns an es256-raw presence key", async () => {
    const calls: unknown[] = [];
    const store = fakeKeystore();
    const device = nativeDeviceKey({
      publicKeys: (options) => (calls.push(options), store.publicKeys(options)),
      sign: (options) => store.sign(options),
    });
    const keys = await device.publicKeys(enrollment(new Uint8Array([251, 255])));
    expect(calls).toEqual([{ presence: true, challenge: "-_8" }]);
    expect(keys.presence).toMatchObject({ format: "es256-raw" });
    expect(keys.presence?.publicKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.proof).toMatchObject({
      keyId: keys.signing.keyId,
      presence: "none",
      format: "es256-raw",
    });
  });

  it("proves possession with a signature over the enrollment bytes", async () => {
    const device = nativeDeviceKey(fakeKeystore());
    const challenge = new Uint8Array([4, 5, 6]);
    const keys = await device.publicKeys(enrollment(challenge));
    const bytes = enrollmentBytes({
      challenge,
      signing: keys.signing.publicKey,
      presence: keys.presence,
    });
    expect(await verifies(keys.signing.publicKey, keys.proof.signature, bytes)).toBe(
      true,
    );
    expect(
      await verifies(keys.signing.publicKey, keys.proof.signature, new Uint8Array([1])),
    ).toBe(false);
  });

  it("signs prompts with the signing key and no presence", async () => {
    const store = fakeKeystore();
    const device = nativeDeviceKey(store);
    const keys = await device.publicKeys(enrollment());
    const payload = new TextEncoder().encode("statement");
    const signature = await device.sign(payload, { presence: false });
    expect(signature).toMatchObject({
      keyId: keys.signing.keyId,
      presence: "none",
      format: "es256-raw",
    });
    expect(await verifies(keys.signing.publicKey, signature.signature, payload)).toBe(
      true,
    );
    expect(store.presenceSigned).toEqual([]);
  });

  it("signs answers with the presence key, which the native side guards with the user", async () => {
    const store = fakeKeystore();
    const device = nativeDeviceKey(store);
    const keys = await device.publicKeys(enrollment());
    const payload = new TextEncoder().encode("answer");
    const signature = await device.sign(payload, { presence: true });
    expect(signature).toMatchObject({
      keyId: keys.presence!.keyId,
      presence: "user",
      format: "es256-raw",
    });
    expect(await verifies(keys.presence!.publicKey, signature.signature, payload)).toBe(
      true,
    );
    expect(await verifies(keys.signing.publicKey, signature.signature, payload)).toBe(
      false,
    );
    expect(store.presenceSigned).toHaveLength(1);
  });

  it("learns the key ids by itself when it signs before enrolling", async () => {
    const device = nativeDeviceKey(fakeKeystore());
    const signature = await device.sign(new Uint8Array([1]), { presence: true });
    expect(signature.presence).toBe("user");
  });

  it("refuses a presence signature where the device has no presence key", async () => {
    const store = fakeKeystore();
    store.withPresence = false;
    const device = nativeDeviceKey(store);
    expect((await device.publicKeys(enrollment())).presence).toBeUndefined();
    await expect(device.sign(new Uint8Array([1]), { presence: true })).rejects.toThrow(
      /no presence key/,
    );
  });
});
