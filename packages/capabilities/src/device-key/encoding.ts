import type { PresencePublicKey } from "./interface.js";

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${serialize(member)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Sorted-key JSON at every level, UTF-8: the same bytes on every device and host. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(value));
}

export function publicPoint(key: JsonWebKey): JsonWebKey {
  return { kty: key.kty!, crv: key.crv!, x: key.x!, y: key.y! };
}

export function enrollmentBytes(input: {
  readonly challenge: Uint8Array;
  readonly signing: JsonWebKey;
  readonly presence: PresencePublicKey | undefined;
}): Uint8Array {
  const { presence } = input;
  return canonicalBytes({
    challenge: encodeBase64url(input.challenge),
    signing: publicPoint(input.signing),
    presence: presence
      ? {
          format: presence.format,
          id: presence.format === "webauthn" ? presence.credentialId : presence.keyId,
          publicKey: publicPoint(presence.publicKey),
        }
      : null,
  });
}

/**
 * Four digits both the computer's approval dialog and the browser show for one device, read
 * off its signing key, so the user can tell the browser asking is the one in front of them.
 */
export async function deviceCode(signingKey: JsonWebKey): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(canonicalBytes(publicPoint(signingKey))),
    ),
  );
  const value = new DataView(digest.buffer).getUint32(0);
  return String(value % 10_000).padStart(4, "0");
}
