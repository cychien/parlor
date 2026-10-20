import { createHash } from "node:crypto";

import { betterAuthProvider, parlorAuth } from "@parlor/auth";
import { chat } from "@parlor/chat/server";
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { createServer, type FrameworkServer } from "@parlor/server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { serve } from "srvx";
import { z } from "zod";

import { hostAssertion } from "./assertion.js";
import type { HostKeys } from "./grants.js";

export const PASSWORD = "correct horse battery staple";

const digest = (password: string) => createHash("sha256").update(password).digest("hex");

/** A signed-in browser: a cookie jar over real HTTP. */
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

  /** Answers the consent page at `url` the way its form does. */
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

/** Hello's shape on Better Auth and PGlite with `chat()`, served over real HTTP. */
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

/** `HostKeys` in memory, for specs that must not touch a Keychain. */
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
