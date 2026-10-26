import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  answerStatement,
  betterAuthProvider,
  deviceCommitment,
  parlorAuth,
  promptStatement,
  statementBytes,
  vouchStatement,
} from "@parlor/auth";
import {
  type AnswerToSign,
  HOST_PROTOCOL,
  type ItemSignature,
  type PromptToSign,
} from "@parlor/chat";
import { chat } from "@parlor/chat/server";
import { asId, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import {
  createServer,
  type DeviceKeys,
  type DeviceVouch,
  type FrameworkServer,
} from "@parlor/server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { serve } from "srvx";
import { z } from "zod";

import { hostAssertion } from "./assertion.js";
import type { AppGrant, HostKeys } from "./grants.js";
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

  /** Answers the consent page as a browser would, sending its checked boxes but `uncheck`. */
  async consent(
    url: string,
    decision: "connect" | "cancel",
    uncheck: readonly string[] = [],
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
    for (const [, name, value] of page.matchAll(
      /<input type="checkbox" name="([^"]+)" value="([^"]*)" checked>/g,
    )) {
      if (!uncheck.includes(name!)) fields.set(name!, value!);
    }
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
    list: async (appOrigin) =>
      [...pinned.entries()]
        .filter(([key]) => key.startsWith(`${appOrigin}\n`))
        .map(([, device]) => device),
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
    presence = false,
  ): Promise<ItemSignature> {
    const statement = await promptStatement(app, prompt, at);
    return this.sign(
      presence ? this.presence : this.signing,
      statementBytes(statement),
      presence ? "user" : "none",
      at,
    );
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

  /** This device's vouch for `device`, signed with its presence key unless `presence` is false. */
  async vouchFor(
    app: string,
    device: DeviceKeys,
    at: number,
    options: { readonly presence?: boolean; readonly commitment?: string } = {},
  ): Promise<DeviceVouch> {
    const commitment =
      options.commitment ??
      (await deviceCommitment(
        app,
        device.id,
        device.signingKey,
        device.presenceKey?.publicKey,
      ));
    const presence = options.presence ?? true;
    const { signature } = await this.sign(
      presence ? this.presence : this.signing,
      statementBytes(vouchStatement(app, this.id, device.id, commitment, at)),
      presence ? "user" : "none",
      at,
    );
    return { voucher: this.id, commitment, at, signature };
  }
}

export interface StubApp {
  readonly origin: string;
  readonly seen: {
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }[];
  close(): Promise<void>;
}

export type Route = (
  request: IncomingMessage,
  body: string,
  response: ServerResponse,
) => boolean;

export async function stubApp(route: Route): Promise<StubApp> {
  const seen: StubApp["seen"][number][] = [];
  const server: Server = createHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://stub").pathname;
      seen.push({ method: request.method ?? "GET", path, body });
      if (!route(request, body, response)) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const json = (response: ServerResponse, value: unknown, status = 200) =>
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));

export const welcome = {
  id: "h",
  accepted: true,
  protocol: HOST_PROTOCOL,
  leaseMs: 60_000,
  heartbeatMs: 30_000,
};

export function hostRoutes(options: {
  readonly wake: boolean;
  readonly turn?: () => unknown;
  /** Pushed on the stream's `chat` channel, as a server on host protocol 3 does. */
  readonly push?: () => unknown;
  /** Handed a way to send sync events on the open stream later, as a tab's writes do. */
  readonly stream?: (send: (tags: readonly (readonly string[])[]) => void) => void;
}): Route {
  let claimed = false;
  return (request, body, response) => {
    const path = new URL(request.url ?? "/", "http://stub").pathname;
    const action = path.startsWith("/_parlor/chat/actions/")
      ? path.split("/").at(-1)
      : undefined;
    if (action === "hostHello")
      return (json(response, { data: welcome, tags: [] }), true);
    if (action === "hostClaim") {
      if (options.turn && !claimed) {
        claimed = true;
        return (json(response, { data: options.turn(), tags: [] }), true);
      }
      return (
        json(response, { error: { code: "not_found", message: "No turn." } }, 404), true
      );
    }
    if (action === "hostSignals") return (json(response, { data: [], tags: [] }), true);
    if (action) {
      return (
        json(response, {
          data: {
            id: "t1",
            leaseUntil: Date.now() + 60_000,
            token: { token: "turn-2", expiresAt: Date.now() + 60_000 },
          },
          tags: [],
        }),
        true
      );
    }
    if (path === "/_parlor/sync/token") {
      return (
        json(response, {
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2_000,
        }),
        true
      );
    }
    if (path === "/_parlor/sync/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const capabilities = options.push ? ["chat"] : [];
      response.write(
        `event: handshake\ndata: ${JSON.stringify({ capabilities, keepAliveMs: 10_000 })}\n\n`,
      );
      if (options.push) {
        const frame = { type: "claimed", turn: options.push() };
        response.write(`event: chat\ndata: ${JSON.stringify(frame)}\n\n`);
      }
      if (options.wake) {
        const events = [{ version: 1, id: "e1", tags: [["parlor_chat", "t1"]] }];
        response.write(
          `event: message\ndata: ${JSON.stringify({ events, cursor: "1.e1" })}\n\n`,
        );
      }
      let version = 1;
      options.stream?.((tags) => {
        version += 1;
        const events = [{ version, id: `e${version}`, tags }];
        const cursor = `${version}.e${version}`;
        response.write(`event: message\ndata: ${JSON.stringify({ events, cursor })}\n\n`);
      });
      return true;
    }
    if (path === "/_parlor/mcp") {
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) return (response.writeHead(202).end(), true);
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : { content: [{ type: "text", text: "[]" }] };
      return (json(response, { jsonrpc: "2.0", id: message.id, result }), true);
    }
    return false;
  };
}

export const claimedTurn = (
  turnId: string,
  agentId: string,
  context: string,
  text: string,
) => ({
  id: "t1",
  turnId,
  agent: { hostId: "h-A", agentId },
  clientId: "tab",
  prompt: {
    id: `p-${turnId}`,
    threadId: "t1",
    turnId,
    seq: 1,
    at: Date.now(),
    author: "user",
    kind: "prompt",
    body: { text, agent: { hostId: "h-A", agentId } },
  },
  device: undefined,
  context,
  token: { token: "turn-1", expiresAt: Date.now() + 60_000 },
  leaseUntil: Date.now() + 60_000,
});

export const grantFor = (origin: string, name: string, workspace: string): AppGrant => ({
  appOrigin: origin,
  appName: name,
  grantId: asId("grant", `host:${name}`),
  hostId: asId("host", `h-${name}`),
  account: { userId: asId("user", "alice"), name: "Alice", email: "alice@example.com" },
  workspace,
  createdAt: 1,
});
