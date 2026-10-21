import { createHash } from "node:crypto";

import {
  answerStatement,
  betterAuthProvider,
  parlorAuth,
  promptStatement,
  statementBytes,
} from "@parlor/auth";
import type { AnswerToSign, ItemSignature, PromptToSign } from "@parlor/chat";
import { chat } from "@parlor/chat/server";
import { asId, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { createServer, type DeviceKeys, type FrameworkServer } from "@parlor/server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { serve } from "srvx";
import { z } from "zod";

import { hostAssertion } from "./assertion.js";
import type { HostKeys } from "./grants.js";
import type { TrustedDevice, TrustStore } from "./trust.js";

export const PASSWORD = "correct horse battery staple";

const digest = (password: string) => createHash("sha256").update(password).digest("hex");

export class Browser {
  readonly #cookies = new Map<string, string>();

  constructor(readonly origin: string) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    if (init.method === "POST" && !headers.has("origin"))
      headers.set("origin", this.origin);
    const response = await fetch(new URL(url, this.origin), {
      ...init,
      headers,
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair!.indexOf("=");
      this.#cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  }

  async consent(
    url: string,
    decision: "connect" | "cancel",
  ): Promise<{
    readonly page: string;
    readonly answer: Response;
  }> {
    const page = await (await this.fetch(url)).text();
    const fields = new URLSearchParams(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(
        (match) => [match[1]!, match[2]!.replaceAll("&amp;", "&")],
      ),
    );
    fields.set("decision", decision);
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1] ?? "";
    const answer = await this.fetch(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    return { page, answer };
  }
}

export interface SpecApp {
  readonly origin: string;
  readonly server: FrameworkServer;
  signUp(name: string): Promise<Browser>;
  close(): Promise<void>;
}

export async function startSpecApp(): Promise<SpecApp> {
  const database: DatabaseHandle = await createDatabase({ dataDir: "memory://" });
  let server: FrameworkServer | undefined;
  const listener = serve({
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    fetch: (request) => server!.fetch(request),
  });
  await listener.ready();
  const origin = new URL(listener.url!).origin;
  const authOptions = parlorAuth({
    origin,
    signInPage: "/sign-in",
    appName: "Hello",
    secret: "a-test-secret-that-is-long-enough-for-better-auth",
    emailAndPassword: {
      enabled: true,
      password: {
        hash: (password) => Promise.resolve(digest(password)),
        verify: ({ hash, password }) => Promise.resolve(digest(password) === hash),
      },
    },
  });
  const tables = Object.values(getAuthTables(authOptions)).map((table) => [
    table.modelName,
    [],
  ]);
  const instance = betterAuth({
    ...authOptions,
    database: memoryAdapter(Object.fromEntries(tables)),
  });
  server = createServer({
    actions: createRegistry({
      listTasks: defineAction({
        description: "List tasks.",
        input: z.object({}),
        run: () => [],
      }),
    }),
    auth: betterAuthProvider({ instance }),
    plugins: [chat()],
    database: {
      read: () => database.read(),
      transaction: (run) => database.transaction(run),
      listen: (channel, handler, options) => database.listen(channel, handler, options),
    },
  });
  return {
    origin,
    server,
    async signUp(name) {
      const browser = new Browser(origin);
      const response = await browser.fetch("/_parlor/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email: `${name.toLowerCase()}@example.com`,
          password: PASSWORD,
        }),
      });
      if (response.status !== 200) throw new Error(`sign-up answered ${response.status}`);
      return browser;
    },
    async close() {
      await listener.close(true);
      await server!.close();
    },
  };
}

export function memoryHostKeys(): HostKeys & {
  readonly origins: () => readonly string[];
} {
  const kept = new Map<string, { key: CryptoKey; kid: string; grantId: string }>();
  const sign = (key: CryptoKey) => async (payload: Uint8Array) =>
    Buffer.from(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new Uint8Array(payload),
      ),
    ).toString("base64url");
  return {
    origins: () => [...kept.keys()],
    async create(appOrigin) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const publicKey = { kty: kty!, crv: crv!, x: x!, y: y! };
      const thumbprint = createHash("sha256")
        .update(JSON.stringify({ crv, kty, x, y }))
        .digest("base64url");
      return {
        publicKey,
        thumbprint,
        sign: sign(pair.privateKey),
        keep: async (grantId) => {
          kept.set(appOrigin, { key: pair.privateKey, kid: thumbprint, grantId });
        },
      };
    },
    async assert(appOrigin, request) {
      const key = kept.get(appOrigin);
      if (!key) throw new Error(`no key for ${appOrigin}`);
      return hostAssertion(sign(key.key), key, request);
    },
    async remove(appOrigin) {
      kept.delete(appOrigin);
    },
  };
}

export function memoryTrust(): TrustStore & { readonly pins: () => TrustedDevice[] } {
  const pinned = new Map<string, TrustedDevice>();
  const keyOf = (appOrigin: string, deviceId: string) => `${appOrigin}\n${deviceId}`;
  return {
    pins: () => [...pinned.values()],
    get: async (appOrigin, deviceId) => pinned.get(keyOf(appOrigin, deviceId)),
    pin: async (appOrigin, device) =>
      void pinned.set(keyOf(appOrigin, device.deviceId), device),
    forget: async (appOrigin, deviceId) => {
      for (const key of [...pinned.keys()]) {
        if (
          key.startsWith(`${appOrigin}\n`) &&
          (deviceId === undefined || key.endsWith(`\n${deviceId}`))
        ) {
          pinned.delete(key);
        }
      }
    },
  };
}

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

export class TestDevice {
  private constructor(
    readonly keys: DeviceKeys,
    private readonly signing: CryptoKey,
    private readonly presence: CryptoKey,
  ) {}

  static async create(
    id = "device-1",
    name = "Chrome on macOS",
    platform = "web",
  ): Promise<TestDevice> {
    const make = async () => {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
      return {
        privateKey: pair.privateKey,
        publicKey: { kty: kty!, crv: crv!, x: x!, y: y! },
      };
    };
    const [signing, presence] = [await make(), await make()];
    return new TestDevice(
      {
        id: asId("device", id),
        name,
        platform,
        signingKey: signing.publicKey,
        presenceKey: {
          format: "es256-raw",
          keyId: "presence",
          publicKey: presence.publicKey,
        },
      },
      signing.privateKey,
      presence.privateKey,
    );
  }

  get id() {
    return this.keys.id;
  }

  private async sign(
    key: CryptoKey,
    bytes: Uint8Array,
    presence: "none" | "user",
    at: number,
  ) {
    const signature = await crypto.subtle.sign(ES256, key, new Uint8Array(bytes));
    return {
      deviceId: this.id,
      at,
      signature: {
        keyId: "key",
        presence,
        format: "es256-raw",
        signature: Buffer.from(signature).toString("base64url"),
      },
    } satisfies ItemSignature;
  }

  async signPrompt(
    app: string,
    prompt: PromptToSign,
    at: number,
  ): Promise<ItemSignature> {
    const statement = await promptStatement(app, prompt, at);
    return this.sign(this.signing, statementBytes(statement), "none", at);
  }

  async signAnswer(
    app: string,
    answer: AnswerToSign,
    at: number,
    presence: boolean,
  ): Promise<ItemSignature> {
    const statement = await answerStatement(app, answer, at);
    return this.sign(
      presence ? this.presence : this.signing,
      statementBytes(statement),
      presence ? "user" : "none",
      at,
    );
  }
}
