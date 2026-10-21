import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import { canonicalBytes } from "@parlor/capabilities/encoding";

declare const __PARLOR_RELEASE_KEY__: string | undefined;

/** The Parlor release public key, base64url, fixed at build time; a build without one trusts no handover. */
export const RELEASE_KEY: string | undefined =
  typeof __PARLOR_RELEASE_KEY__ === "undefined" ? undefined : __PARLOR_RELEASE_KEY__;

export const RELEASE_PLATFORM = `${process.platform}-${process.arch}`;

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ReleaseSignature {
  readonly v: 1;
  readonly version: string;
  readonly platform: string;
  /** hex SHA-256 of the binary */
  readonly sha256: string;
  /** base64url Ed25519 over `releaseBytes` */
  readonly signature: string;
}

export const isVersion = (text: string) => VERSION.test(text);

/** Numeric `major.minor.patch`: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => {
    const match = VERSION.exec(version);
    if (!match) throw new Error(`"${version}" is not a major.minor.patch version.`);
    return match.slice(1).map(Number);
  }) as [number[], number[]];
  for (let at = 0; at < 3; at += 1) {
    const difference = left[at]! - right[at]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function releaseBytes(signature: Omit<ReleaseSignature, "signature">): Uint8Array {
  const { v, version, platform, sha256 } = signature;
  return canonicalBytes({ v, version, platform, sha256 });
}

export function parseReleaseSignature(text: string): ReleaseSignature | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { v, version, platform, sha256, signature } = value as Record<string, unknown>;
  if (v !== 1) return undefined;
  if (typeof version !== "string" || !isVersion(version)) return undefined;
  if (typeof platform !== "string" || typeof signature !== "string") return undefined;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { v, version, platform, sha256, signature };
}

export function signatureHolds(
  signature: ReleaseSignature,
  key: string | undefined,
): boolean {
  if (key === undefined) return false;
  try {
    return verify(
      null,
      releaseBytes(signature),
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" }),
      Buffer.from(signature.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .once("end", () => resolve(hash.digest("hex")))
      .once("error", reject);
  });
}

/**
 * The signed release a binary is: its `.sig` verifies under `key`, names this platform,
 * and its hash is the binary's own. `undefined` for anything else.
 */
export async function signedRelease(
  binary: string,
  signatureFile: string,
  key: string | undefined,
): Promise<ReleaseSignature | undefined> {
  const signature = parseReleaseSignature(
    await readFile(signatureFile, "utf8").catch(() => ""),
  );
  if (!signature || signature.platform !== RELEASE_PLATFORM) return undefined;
  if (!signatureHolds(signature, key)) return undefined;
  const actual = await sha256File(binary).catch(() => undefined);
  return actual === signature.sha256 ? signature : undefined;
}
