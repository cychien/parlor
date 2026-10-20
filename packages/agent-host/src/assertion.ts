import { randomUUID } from "node:crypto";

import { HOST_ASSERTION_TTL_MS, HOST_ASSERTION_TYP, HOST_AUDIENCE } from "@parlor/auth";

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export interface AssertionRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
}

export async function hostAssertion(
  sign: (payload: Uint8Array) => Promise<string>,
  key: { readonly kid: string; readonly grantId: string },
  request: AssertionRequest,
  now: number = Date.now(),
): Promise<string> {
  const target = new URL(request.url);
  target.search = "";
  target.hash = "";
  const iat = Math.floor(now / 1000);
  const header = encode({ alg: "ES256", typ: HOST_ASSERTION_TYP, kid: key.kid });
  const claims = encode({
    aud: HOST_AUDIENCE,
    gid: key.grantId,
    htm: request.method,
    htu: target.href,
    iat,
    exp: iat + HOST_ASSERTION_TTL_MS / 1000,
    jti: randomUUID(),
  });
  const input = `${header}.${claims}`;
  return `${input}.${await sign(new TextEncoder().encode(input))}`;
}
