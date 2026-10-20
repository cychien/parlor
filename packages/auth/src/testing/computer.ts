import { createHash, randomBytes } from "node:crypto";

import type { FrameworkServer } from "@parlor/server";

import type { HostGrantResponse } from "../hosts.js";
import { type Browser, ORIGIN } from "./app.js";

const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer | Uint8Array | Buffer) =>
  Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString(
    "base64url",
  );

export interface Pairing {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly hostName: string;
  readonly platform: string;
  readonly matchingCode: string;
  readonly keyThumbprint: string;
}

export interface Assertion {
  readonly method?: "GET" | "POST" | undefined;
  readonly url: string;
  readonly iat?: number | undefined;
  readonly jti?: string | undefined;
  readonly gid?: string | undefined;
  readonly aud?: string | undefined;
}

export class Computer {
  readonly codeVerifier = base64url(randomBytes(32));
  readonly state = base64url(randomBytes(12));
  readonly matchingCode = "K7M-4PX";
  grant: HostGrantResponse | undefined;
  #keys: CryptoKeyPair | undefined;
  #jwk: JsonWebKey | undefined;

  constructor(
    readonly hostName = "Fake host",
    readonly platform = "macos",
    readonly redirectUri = "http://127.0.0.1:43124/callback",
  ) {}

  async publicKey(): Promise<JsonWebKey> {
    if (!this.#jwk) {
      this.#keys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const { kty, crv, x, y } = await crypto.subtle.exportKey(
        "jwk",
        this.#keys.publicKey,
      );
      this.#jwk = { kty, crv, x, y };
    }
    return this.#jwk;
  }

  async thumbprint(): Promise<string> {
    const { crv, kty, x, y } = await this.publicKey();
    return base64url(
      createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest(),
    );
  }

  async sign(bytes: Uint8Array): Promise<string> {
    await this.publicKey();
    return base64url(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.#keys!.privateKey,
        bytes,
      ),
    );
  }

  async pairing(): Promise<Pairing> {
    return {
      redirectUri: this.redirectUri,
      codeChallenge: base64url(createHash("sha256").update(this.codeVerifier).digest()),
      state: this.state,
      hostName: this.hostName,
      platform: this.platform,
      matchingCode: this.matchingCode,
      keyThumbprint: await this.thumbprint(),
    };
  }

  async authorizeQuery(): Promise<string> {
    return new URLSearchParams(await this.pairing()).toString();
  }

  async approve(browser: Browser, decision: "connect" | "cancel" = "connect") {
    const body = new URLSearchParams({ ...(await this.pairing()), decision });
    return browser.fetch("/_parlor/auth/hosts/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
  }

  async exchange(
    server: FrameworkServer,
    code: string,
    overrides: { proof?: string; codeVerifier?: string } = {},
  ) {
    const proof = overrides.proof ?? (await this.sign(encoder.encode(code)));
    return fetchJson(server, "/_parlor/auth/hosts/token", {
      code,
      codeVerifier: overrides.codeVerifier ?? this.codeVerifier,
      publicKey: await this.publicKey(),
      proof,
    });
  }

  async assertion(request: Assertion): Promise<string> {
    const iat = request.iat ?? Math.floor(Date.now() / 1000);
    const header = { alg: "ES256", typ: "parlor-host+jwt", kid: await this.thumbprint() };
    const payload = {
      aud: request.aud ?? "parlor:host",
      gid: request.gid ?? this.grant?.grant.id,
      htm: request.method ?? "POST",
      htu: request.url,
      iat,
      exp: iat + 60,
      jti: request.jti ?? base64url(randomBytes(16)),
    };
    const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
    return `${input}.${await this.sign(encoder.encode(input))}`;
  }
}

async function fetchJson(server: FrameworkServer, path: string, body: unknown) {
  const response = await server.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

export async function pair(
  server: FrameworkServer,
  browser: Browser,
  computer = new Computer(),
) {
  const answer = await computer.approve(browser);
  const code = new URL(answer.headers.get("location")!).searchParams.get("code")!;
  const exchange = await computer.exchange(server, code);
  if (exchange.status !== 200) throw new Error(`pairing answered ${exchange.status}`);
  computer.grant = exchange.body as unknown as HostGrantResponse;
  return computer;
}

export async function callWith(
  server: FrameworkServer,
  path: string,
  authorization: string | undefined,
  init: { readonly method?: "GET" | "POST" } = {},
) {
  const method = init.method ?? "POST";
  const response = await server.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(authorization ? { authorization } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, any>) : undefined,
  };
}

export const HELLO = "/_parlor/probe/actions/hostHello";
