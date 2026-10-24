import { createHash } from "node:crypto";

import { type DataProvider, defineAction } from "@parlor/core";
import { type ActionRegistry, createRegistry } from "@parlor/core/registry";
import type { DatabaseHandle } from "@parlor/data";
import {
  type AuthProvider,
  createServer,
  type FrameworkServer,
  type ServerPlugin,
} from "@parlor/server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { z } from "zod";

import { parlorAuth, type ParlorAuthOptions } from "../better-auth.js";
import { betterAuthProvider } from "../provider.js";

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery staple";

const actions = createRegistry({
  whoami: defineAction({
    description: "Who is calling.",
    input: z.object({}),
    run: (_input, ctx) => ({
      principal: ctx.principal,
      scope: ctx.scope,
      source: ctx.source,
    }),
  }),
  ping: defineAction({
    description: "Anyone may ping.",
    input: z.object({}),
    public: true,
    run: () => ({ pong: true }),
  }),
});

const digest = (password: string) => createHash("sha256").update(password).digest("hex");

export interface TestApp {
  readonly server: FrameworkServer;
  readonly instance: ReturnType<typeof betterAuth>;
  readonly provider: AuthProvider;
}

export interface TestAppOptions {
  readonly actions?: ActionRegistry | undefined;
  readonly plugins?: readonly ServerPlugin[] | undefined;
  readonly wrap?: ((provider: DataProvider) => DataProvider) | undefined;
  readonly secret?: string | undefined;
  /** More Better Auth options, such as social providers and plugins. */
  readonly auth?: Partial<ParlorAuthOptions> | undefined;
}

/** A hello-like app on Better Auth's memory adapter, with revocations in `database`. */
export function createTestApp(
  database: DatabaseHandle,
  options: TestAppOptions = {},
): TestApp {
  const authOptions = parlorAuth({
    origin: ORIGIN,
    signInPage: "/sign-in",
    appName: "Hello",
    secret: options.secret ?? "a-test-secret-that-is-long-enough-for-better-auth",
    emailAndPassword: {
      enabled: true,
      // scrypt dominates these tests under a parallel run; hashing is not what they check.
      password: {
        hash: (password) => Promise.resolve(digest(password)),
        verify: ({ hash, password }) => Promise.resolve(digest(password) === hash),
      },
    },
    ...options.auth,
  });
  const tables = Object.values(getAuthTables(authOptions)).map((table) => [
    table.modelName,
    [],
  ]);
  const instance = betterAuth({
    ...authOptions,
    database: memoryAdapter(Object.fromEntries(tables)),
  });
  const provider = betterAuthProvider({ instance });
  const server = createServer({
    actions: options.actions ?? actions,
    auth: provider,
    ...(options.plugins ? { plugins: options.plugins } : {}),
    database: (options.wrap ?? ((data) => data))({
      read: () => database.read(),
      transaction: (run) => database.transaction(run),
      listen: (channel, handler, listening) =>
        database.listen(channel, handler, listening),
    }),
  });
  return { server, instance, provider };
}

/** A browser tab: keeps cookies like one, and remembers the bearer token a sign-in hands out. */
export class Browser {
  readonly #server: FrameworkServer;
  readonly #cookies = new Map<string, string>();
  token: string | undefined;

  constructor(server: FrameworkServer) {
    this.#server = server;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    if (init.method === "POST" && !headers.has("origin")) headers.set("origin", ORIGIN);
    const response = await this.#server.fetch(
      new Request(`${ORIGIN}${path}`, { ...init, headers }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (value === "" || /max-age=0/i.test(cookie)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    this.token = response.headers.get("set-auth-token") ?? this.token;
    return response;
  }

  post(path: string, body: unknown, headers: HeadersInit = {}) {
    return this.fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      body: JSON.stringify(body),
    });
  }

  async account(action: string, input: unknown = {}) {
    const response = await this.post(`/_parlor/auth/actions/${action}`, input);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }
}

const emailOf = (name: string) => `${name.toLowerCase()}@example.com`;

export async function signUp(server: FrameworkServer, name: string): Promise<Browser> {
  const browser = new Browser(server);
  const response = await browser.post("/_parlor/auth/sign-up/email", {
    name,
    email: emailOf(name),
    password: PASSWORD,
  });
  if (response.status !== 200) throw new Error(`sign-up answered ${response.status}`);
  return browser;
}

export async function signIn(server: FrameworkServer, name: string): Promise<Browser> {
  const browser = new Browser(server);
  const response = await browser.post("/_parlor/auth/sign-in/email", {
    email: emailOf(name),
    password: PASSWORD,
  });
  if (response.status !== 200) throw new Error(`sign-in answered ${response.status}`);
  return browser;
}
