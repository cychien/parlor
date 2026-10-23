import { describe, expect, it } from "vitest";

import {
  canonicalBytes,
  deviceCode,
  decodeBase64url,
  encodeBase64url,
  enrollmentBytes,
} from "./encoding.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("canonicalBytes", () => {
  it("sorts keys at every level, whatever order they were written in", () => {
    expect(text(canonicalBytes({ zeta: 1, a: { y: 2, b: [{ d: 1, c: 2 }] } }))).toBe(
      '{"a":{"b":[{"c":2,"d":1}],"y":2},"zeta":1}',
    );
  });

  it("sorts integer-like keys as text, not as numbers", () => {
    expect(text(canonicalBytes({ b: 1, 10: 2, 2: 3 }))).toBe('{"10":2,"2":3,"b":1}');
  });

  it("writes UTF-8 without escaping it and skips undefined members", () => {
    const bytes = canonicalBytes({ text: "é你😀", gone: undefined });
    expect(text(bytes)).toBe('{"text":"é你😀"}');
    expect([...bytes.slice(9, 11)]).toEqual([0xc3, 0xa9]);
  });
});

describe("base64url", () => {
  it("round-trips without padding or the plus and slash alphabet", () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1]);
    expect(encodeBase64url(bytes)).toBe("-__-AAE");
    expect([...decodeBase64url("-__-AAE")]).toEqual([...bytes]);
  });
});

describe("enrollmentBytes", () => {
  const signing = { kty: "EC", crv: "P-256", x: "x1", y: "y1", ext: true };

  it("binds the challenge and both public keys, and nothing else of the key", () => {
    const withPresence = enrollmentBytes({
      challenge: new Uint8Array([1]),
      signing,
      presence: {
        format: "webauthn",
        credentialId: "cred",
        publicKey: { kty: "EC", crv: "P-256", x: "x2", y: "y2" },
        attestation: "ignored",
      },
    });
    expect(JSON.parse(text(withPresence))).toEqual({
      challenge: "AQ",
      signing: { kty: "EC", crv: "P-256", x: "x1", y: "y1" },
      presence: {
        format: "webauthn",
        id: "cred",
        publicKey: { kty: "EC", crv: "P-256", x: "x2", y: "y2" },
      },
    });
    expect(
      JSON.parse(
        text(
          enrollmentBytes({
            challenge: new Uint8Array([1]),
            signing,
            presence: undefined,
          }),
        ),
      ).presence,
    ).toBeNull();
  });
});

describe("deviceCode", () => {
  it("is four digits read off the public point, the same with or without the private part", async () => {
    const key = { kty: "EC", crv: "P-256", x: "x1", y: "y1" };
    const code = await deviceCode(key);
    expect(code).toMatch(/^\d{4}$/);
    expect(await deviceCode({ ...key, d: "private", ext: true })).toBe(code);
    expect(await deviceCode({ ...key, x: "x2" })).not.toBe(code);
  });
});
