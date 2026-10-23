import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { resolveCapability } from "../capability.js";
import {
  decodeBase64url,
  enrollmentBytes,
  encodeBase64url,
  publicPoint,
} from "./encoding.js";
import { deviceKey, PresenceSetupCancelled } from "./index.js";
import { fakeApis, fakeAuthenticator, fakeIndexedDB } from "./spec-kit.js";
import { webDeviceKey } from "./web.js";

const ORIGIN = "https://hello.example";
const enrollment = (challenge = new Uint8Array([1, 2, 3])) => ({
  rpId: "hello.example",
  userId: "user-1",
  userName: "alice@example.com",
  challenge,
});
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

async function created(options: { cancel?: boolean } = {}) {
  const storage = fakeIndexedDB();
  const authenticator = fakeAuthenticator(ORIGIN);
  authenticator.cancel = options.cancel ?? false;
  const open = async () =>
    webDeviceKey(
      fakeApis({ indexedDB: storage.factory, credentials: authenticator.credentials }),
    ).create();
  return { storage, authenticator, device: await open(), open };
}

describe("webDeviceKey availability", () => {
  it("needs WebCrypto and IndexedDB, and works without passkeys", () => {
    const storage = fakeIndexedDB();
    expect(webDeviceKey(fakeApis({ indexedDB: storage.factory })).available()).toBe(true);
    expect(webDeviceKey(fakeApis({})).available()).toBe(false);
    expect(
      webDeviceKey(() => ({
        subtle: undefined,
        indexedDB: storage.factory,
        credentials: undefined,
      })).available(),
    ).toBe(false);
    expect(() => webDeviceKey(fakeApis({})).create()).toThrow(/cannot keep a device key/);
  });

  it("is unavailable where the browser has no IndexedDB, as under happy-dom", async () => {
    expect((await resolveCapability(deviceKey, "web")).available).toBe(false);
  });
});

describe("webDeviceKey publicKeys", () => {
  it("makes one signing key in the parlor database and keeps it across loads", async () => {
    const { storage, device, open } = await created();
    const first = await device.publicKeys(enrollment());
    const again = await (await open()).publicKeys(enrollment(new Uint8Array([9])));
    expect(again.signing).toEqual(first.signing);
    expect([...storage.databases.keys()]).toEqual(["parlor"]);
    const stored = storage.databases.get("parlor")!.get("parlor-device")!;
    expect([...stored.keys()].sort()).toEqual(["presence", "signing"]);
    const pair = stored.get("signing") as CryptoKeyPair;
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();
    expect(first.signing.keyId).toBe(
      encodeBase64url(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify({
                crv: "P-256",
                kty: "EC",
                x: first.signing.publicKey.x,
                y: first.signing.publicKey.y,
              }),
            ),
          ),
        ),
      ),
    );
  });

  it("proves possession by signing the challenge with both public keys", async () => {
    const { device } = await created();
    const challenge = new Uint8Array([4, 5, 6]);
    const keys = await device.publicKeys(enrollment(challenge));
    expect(keys.proof).toMatchObject({ presence: "none", format: "es256-raw" });
    const bytes = enrollmentBytes({
      challenge,
      signing: keys.signing.publicKey,
      presence: keys.presence,
    });
    expect(await verifies(keys.signing.publicKey, keys.proof.signature, bytes)).toBe(
      true,
    );
    const other = enrollmentBytes({
      challenge: new Uint8Array([7]),
      signing: keys.signing.publicKey,
      presence: keys.presence,
    });
    expect(await verifies(keys.signing.publicKey, keys.proof.signature, other)).toBe(
      false,
    );
  });

  it("creates a platform passkey that requires user verification, once", async () => {
    const { authenticator, device, open } = await created();
    const keys = await device.publicKeys(enrollment());
    await (await open()).publicKeys(enrollment());
    expect(authenticator.created).toHaveLength(1);
    expect(authenticator.created[0]).toMatchObject({
      rp: { id: "hello.example" },
      user: { name: "alice@example.com" },
      attestation: "none",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
      },
    });
    expect(keys.presence).toMatchObject({ format: "webauthn", attestation: "oA" });
    expect(keys.presence?.publicKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(publicPoint(keys.presence!.publicKey)).toEqual(keys.presence!.publicKey);
  });

  it("omits presence where the browser has no passkeys", async () => {
    const storage = fakeIndexedDB();
    const device = await webDeviceKey(fakeApis({ indexedDB: storage.factory })).create();
    const keys = await device.publicKeys(enrollment());
    expect(keys.presence).toBeUndefined();
    await expect(device.sign(new Uint8Array([1]), { presence: true })).rejects.toThrow(
      /no presence key/,
    );
  });

  it("keeps nothing when the user cancels the passkey, so the next enrollment asks again", async () => {
    const { authenticator, device, open } = await created({ cancel: true });
    expect(await device.presenceSetup!()).toBe("needed");
    await expect(device.publicKeys(enrollment())).rejects.toBeInstanceOf(
      PresenceSetupCancelled,
    );
    expect(await (await open()).presenceSetup!()).toBe("needed");
    authenticator.cancel = false;
    const keys = await (await open()).publicKeys(enrollment());
    expect(keys.presence).toMatchObject({ format: "webauthn" });
    expect(authenticator.created).toHaveLength(2);
    expect(await device.presenceSetup!()).toBe("done");
  });

  it("settles without a passkey for good when presence is declined, and never asks", async () => {
    const { authenticator, device, open } = await created();
    expect((await device.publicKeys(enrollment(), { presence: false })).presence).toBe(
      undefined,
    );
    expect((await (await open()).publicKeys(enrollment())).presence).toBeUndefined();
    expect(authenticator.created).toEqual([]);
    expect(await device.presenceSetup!()).toBe("done");
  });

  it("needs no setup and makes no passkey where there is no platform authenticator", async () => {
    const storage = fakeIndexedDB();
    const authenticator = fakeAuthenticator(ORIGIN);
    const device = webDeviceKey(
      fakeApis({
        indexedDB: storage.factory,
        credentials: authenticator.credentials,
        platformAuthenticator: false,
      }),
    ).create();
    expect(await device.presenceSetup!()).toBe("done");
    expect((await device.publicKeys(enrollment())).presence).toBeUndefined();
    expect(authenticator.created).toEqual([]);
  });
});

describe("webDeviceKey sign", () => {
  it("signs without asking the user when no presence is wanted", async () => {
    const { authenticator, device } = await created();
    const keys = await device.publicKeys(enrollment());
    const payload = new TextEncoder().encode("a prompt");
    const signature = await device.sign(payload, { presence: false });
    expect(signature).toMatchObject({
      keyId: keys.signing.keyId,
      presence: "none",
      format: "es256-raw",
    });
    expect(await verifies(keys.signing.publicKey, signature.signature, payload)).toBe(
      true,
    );
    expect(authenticator.requested).toHaveLength(0);
  });

  it("asks the passkey over the payload's SHA-256 when presence is wanted", async () => {
    const { authenticator, device } = await created();
    const keys = await device.publicKeys(enrollment());
    const payload = new TextEncoder().encode("an answer");
    const signature = await device.sign(payload, { presence: true });
    const [request] = authenticator.requested;
    expect(request).toMatchObject({
      rpId: "hello.example",
      userVerification: "required",
    });
    expect(encodeBase64url(new Uint8Array(request!.challenge as ArrayBuffer))).toBe(
      createHash("sha256").update(payload).digest("base64url"),
    );
    expect(signature).toMatchObject({
      keyId:
        keys.presence && "credentialId" in keys.presence
          ? keys.presence.credentialId
          : "",
      presence: "user",
      format: "webauthn",
    });
    const clientData = JSON.parse(
      new TextDecoder().decode(decodeBase64url(signature.clientDataJSON!)),
    ) as { challenge: string; origin: string };
    expect(clientData).toMatchObject({
      challenge: createHash("sha256").update(payload).digest("base64url"),
      origin: ORIGIN,
    });
  });

  it("fails when the user does not give presence", async () => {
    const { authenticator, device } = await created();
    await device.publicKeys(enrollment());
    authenticator.userVerified = false;
    await expect(
      device.sign(new Uint8Array([1]), { presence: true }),
    ).rejects.toMatchObject({
      name: "NotAllowedError",
    });
  });
});
