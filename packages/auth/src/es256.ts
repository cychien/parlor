const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256_SCALAR_BYTES = 32;

/** WebAuthn signs in ASN.1 DER; WebCrypto verifies the raw `r || s`. */
export function derToRaw(der: Uint8Array): Uint8Array | undefined {
  let at = 0;
  const expect = (tag: number) => der[at++] === tag;
  const length = () => {
    const first = der[at++];
    if (first === undefined || first < 0x80) return first;
    if (first !== 0x81) return undefined;
    return der[at++];
  };
  const integer = () => {
    if (!expect(0x02)) return undefined;
    const size = length();
    if (size === undefined) return undefined;
    const bytes = der.slice(at, at + size);
    at += size;
    const trimmed = bytes.slice(bytes.findIndex((byte) => byte !== 0));
    if (bytes.length !== size || trimmed.length > P256_SCALAR_BYTES) return undefined;
    return trimmed;
  };
  if (!expect(0x30) || length() !== der.length - at) return undefined;
  const r = integer();
  const s = integer();
  if (!r || !s || at !== der.length) return undefined;
  const raw = new Uint8Array(2 * P256_SCALAR_BYTES);
  raw.set(r, P256_SCALAR_BYTES - r.length);
  raw.set(s, 2 * P256_SCALAR_BYTES - s.length);
  return raw;
}

export async function verifyEs256(
  publicKey: JsonWebKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey("jwk", publicKey, P256, false, ["verify"]);
  return crypto.subtle.verify(
    ES256,
    key,
    new Uint8Array(signature),
    new Uint8Array(data),
  );
}
