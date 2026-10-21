import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareVersions,
  parseReleaseSignature,
  RELEASE_KEY,
  RELEASE_PLATFORM,
  type ReleaseSignature,
  releaseBytes,
  sha256File,
  signatureHolds,
  signedRelease,
} from "./release.js";

const pair = () => generateKeyPairSync("ed25519");
const publicKeyOf = (key: ReturnType<typeof pair>["publicKey"]) =>
  key.export({ format: "jwk" }).x!;

function signed(
  key: ReturnType<typeof pair>["privateKey"],
  fields: Partial<Omit<ReleaseSignature, "signature">> & { sha256: string },
): ReleaseSignature {
  const body = { v: 1 as const, version: "1.2.3", platform: RELEASE_PLATFORM, ...fields };
  return {
    ...body,
    signature: sign(null, releaseBytes(body), key).toString("base64url"),
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-release-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("release versions", () => {
  it("compares major, minor and patch as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.0.1", "0.0.2")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("10.0.0", "9.99.99")).toBeGreaterThan(0);
  });

  it("refuses a version that is not major.minor.patch", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow();
    expect(() => compareVersions("1.2.3-beta", "1.2.3")).toThrow();
  });
});

describe("release signatures", () => {
  it("signs the canonical bytes of version, platform and hash", () => {
    expect(
      new TextDecoder().decode(
        releaseBytes({ v: 1, version: "1.2.3", platform: "darwin-arm64", sha256: "ab" }),
      ),
    ).toBe('{"platform":"darwin-arm64","sha256":"ab","v":1,"version":"1.2.3"}');
  });

  it("holds under the key that signed it and under no other", () => {
    const keys = pair();
    const signature = signed(keys.privateKey, { sha256: "a".repeat(64) });
    expect(signatureHolds(signature, publicKeyOf(keys.publicKey))).toBe(true);
    expect(signatureHolds(signature, publicKeyOf(pair().publicKey))).toBe(false);
    expect(signatureHolds(signature, undefined)).toBe(false);
  });

  it("does not hold once the version, platform or hash is relabeled", () => {
    const keys = pair();
    const key = publicKeyOf(keys.publicKey);
    const signature = signed(keys.privateKey, { sha256: "a".repeat(64) });
    expect(signatureHolds({ ...signature, version: "9.9.9" }, key)).toBe(false);
    expect(signatureHolds({ ...signature, platform: "linux-x64" }, key)).toBe(false);
    expect(signatureHolds({ ...signature, sha256: "b".repeat(64) }, key)).toBe(false);
  });

  it("is not fooled by a signature that is not base64url", () => {
    const keys = pair();
    const signature = signed(keys.privateKey, { sha256: "a".repeat(64) });
    expect(
      signatureHolds({ ...signature, signature: "***" }, publicKeyOf(keys.publicKey)),
    ).toBe(false);
  });

  it("parses only the one format", () => {
    const good = {
      v: 1,
      version: "1.2.3",
      platform: "darwin-arm64",
      sha256: "a".repeat(64),
      signature: "c2ln",
    };
    expect(parseReleaseSignature(JSON.stringify(good))).toEqual(good);
    expect(parseReleaseSignature("not json")).toBeUndefined();
    expect(parseReleaseSignature(JSON.stringify({ ...good, v: 2 }))).toBeUndefined();
    expect(
      parseReleaseSignature(JSON.stringify({ ...good, version: "../../x" })),
    ).toBeUndefined();
    expect(
      parseReleaseSignature(JSON.stringify({ ...good, sha256: "zz" })),
    ).toBeUndefined();
  });

  it("builds without a trusted key outside a release build, so it trusts no handover", () => {
    expect(RELEASE_KEY).toBeUndefined();
  });
});

describe("signedRelease", () => {
  it("accepts the binary the signature describes", async () => {
    const keys = pair();
    const binary = join(dir, "good-binary");
    await writeFile(binary, "binary bytes");
    const signature = signed(keys.privateKey, { sha256: await sha256File(binary) });
    await writeFile(`${binary}.sig`, JSON.stringify(signature));
    expect(
      await signedRelease(binary, `${binary}.sig`, publicKeyOf(keys.publicKey)),
    ).toEqual(signature);
  });

  it("refuses a binary that changed after it was signed", async () => {
    const keys = pair();
    const binary = join(dir, "tampered-binary");
    await writeFile(binary, "binary bytes");
    const signature = signed(keys.privateKey, { sha256: await sha256File(binary) });
    await writeFile(`${binary}.sig`, JSON.stringify(signature));
    await writeFile(binary, "other bytes");
    expect(
      await signedRelease(binary, `${binary}.sig`, publicKeyOf(keys.publicKey)),
    ).toBeUndefined();
  });

  it("refuses a signature made for another platform, another key, or a missing file", async () => {
    const keys = pair();
    const binary = join(dir, "other-binary");
    await writeFile(binary, "binary bytes");
    const hash = await sha256File(binary);
    const key = publicKeyOf(keys.publicKey);
    await writeFile(
      `${binary}.sig`,
      JSON.stringify(signed(keys.privateKey, { sha256: hash, platform: "linux-x64" })),
    );
    expect(await signedRelease(binary, `${binary}.sig`, key)).toBeUndefined();
    await writeFile(
      `${binary}.sig`,
      JSON.stringify(signed(pair().privateKey, { sha256: hash })),
    );
    expect(await signedRelease(binary, `${binary}.sig`, key)).toBeUndefined();
    expect(await signedRelease(binary, join(dir, "missing.sig"), key)).toBeUndefined();
  });
});
