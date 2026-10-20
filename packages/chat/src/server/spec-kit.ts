import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ANONYMOUS,
  asId,
  type AuthenticatedPrincipal,
  type DataProvider,
  type Principal,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import {
  type AuthProvider,
  createServer,
  type FrameworkServer,
  type ScopeResolver,
} from "@parlor/server";
import { sql } from "drizzle-orm";

import { chat, type ChatOptions } from "./index.js";
import type { ChatDb } from "./store.js";

export const alice = asId("user", "alice");
export const bob = asId("user", "bob");

export const TOKENS: Readonly<Record<string, AuthenticatedPrincipal>> = {
  alice: { kind: "user", userId: alice, sessionId: "s-alice" },
  bob: { kind: "user", userId: bob, sessionId: "s-bob" },
  "alice-host": {
    kind: "host",
    userId: alice,
    grantId: asId("grant", "g-mac"),
    hostId: asId("host", "mac"),
  },
  "alice-host-2": {
    kind: "host",
    userId: alice,
    grantId: asId("grant", "g-pc"),
    hostId: asId("host", "pc"),
  },
  "bob-host": {
    kind: "host",
    userId: bob,
    grantId: asId("grant", "g-bob"),
    hostId: asId("host", "bob-mac"),
  },
  "alice-agent": {
    kind: "agent",
    userId: alice,
    grantId: asId("grant", "g-claude"),
    agent: { name: "Claude Code", verified: true },
  },
};

export interface Delegated {
  readonly hostId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly clientId: string;
  readonly agent: string;
  readonly ttlMs: number;
}

export interface TestAuth extends AuthProvider {
  readonly delegated: Delegated[];
  readonly revokedGrants: Set<string>;
}

export interface ProviderIo {
  readonly database: DataProvider;
  failDelegate?: Error | undefined;
}

export function testAuth(enforcing = true, io?: ProviderIo): TestAuth {
  const delegated: Delegated[] = [];
  const revokedGrants = new Set<string>();
  const touchDatabase = async () => {
    if (io) await (io.database.read() as ChatDb).execute(sql`select 1`);
  };
  return {
    name: "test-auth",
    enforcing,
    delegated,
    revokedGrants,
    async hostActive(grantId) {
      await touchDatabase();
      return !revokedGrants.has(grantId);
    },
    setup: () => ({}),
    authenticate(request): Promise<Principal> {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      return Promise.resolve((token && TOKENS[token]) || ANONYMOUS);
    },
    challenge: () => new Response(null, { status: 401 }),
    revoked: () => new AbortController().signal,
    async delegate(host, turn) {
      await touchDatabase();
      if (io?.failDelegate) throw io.failDelegate;
      delegated.push({ hostId: host.hostId, ...turn });
      return {
        token: `turn.${turn.turnId}.${delegated.length}`,
        expiresAt: Date.now() + turn.ttlMs,
      };
    },
    async account(userId) {
      await touchDatabase();
      return { name: userId === alice ? "Alice" : "Bob" };
    },
    async device() {
      await touchDatabase();
      return undefined;
    },
  };
}

export interface Driver {
  readonly name: "pglite" | "node-postgres";
  readonly url?: string;
}

const url = process.env.PARLOR_TEST_DATABASE_URL;
export const drivers: readonly Driver[] = [
  { name: "pglite" },
  ...(url ? [{ name: "node-postgres" as const, url }] : []),
];

async function scratchDatabase(baseUrl: string): Promise<DatabaseHandle> {
  const name = `parlor_test_${randomBytes(6).toString("hex")}`;
  const onServer = async (statement: string) => {
    const admin = await createDatabase({ url: baseUrl });
    try {
      await admin.db.execute(sql.raw(statement));
    } finally {
      await admin.close();
    }
  };
  await onServer(`create database ${name}`);
  const scratchUrl = new URL(baseUrl);
  scratchUrl.pathname = `/${name}`;
  const handle = await createDatabase({ url: scratchUrl.href });
  return {
    ...handle,
    close: async () => {
      await handle.close();
      await onServer(`drop database if exists ${name} with (force)`);
    },
  };
}

export async function openDatabase(driver: Driver): Promise<DatabaseHandle> {
  const handle = await (driver.url
    ? scratchDatabase(driver.url)
    : createDatabase({ dataDir: "memory://" }));
  await handle.db.execute(sql`select 1`);
  return handle;
}

export async function resetDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(sql`drop schema public cascade`);
  await handle.db.execute(sql`create schema public`);
}

export interface Counted extends DataProvider {
  readonly transactions: number;
  resetCount(): void;
}

export function counted(handle: DatabaseHandle): Counted {
  let transactions = 0;
  return {
    read: () => handle.db,
    transaction: (run) => {
      transactions += 1;
      return handle.transaction(run);
    },
    listen: (channel, handler, options) => handle.listen(channel, handler, options),
    get transactions() {
      return transactions;
    },
    resetCount() {
      transactions = 0;
    },
  };
}

export interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

export interface ChatServer {
  readonly server: FrameworkServer;
  readonly auth: TestAuth;
  post(token: string | undefined, path: string, body: unknown): Promise<Reply>;
  action(token: string | undefined, name: string, input: unknown): Promise<Reply>;
}

export function serveChat(
  database: DataProvider,
  options: {
    chat?: ChatOptions;
    enforcing?: boolean;
    scope?: ScopeResolver;
    providerIo?: ProviderIo;
  } = {},
): ChatServer {
  const auth = testAuth(options.enforcing ?? true, options.providerIo);
  const server = createServer({
    actions: createRegistry({}),
    auth,
    ...(options.scope ? { scope: options.scope } : {}),
    database: {
      read: () => database.read(),
      transaction: (run) => database.transaction(run),
      ...(database.listen ? { listen: database.listen.bind(database) } : {}),
    },
    plugins: [chat(options.chat)],
  });
  const post: ChatServer["post"] = async (token, path, body) => {
    const response = await server.fetch(
      new Request(`http://app.test/_parlor/chat/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, text, body: parsed };
  };
  return {
    server,
    auth,
    post,
    action: (token, name, input) => post(token, `actions/${name}`, input),
  };
}

export const agentRef = { hostId: "mac", agentId: "claude" };

export function data(reply: Reply): unknown {
  return (reply.body as { data: unknown }).data;
}

export async function rows(handle: DatabaseHandle, query: string): Promise<unknown[]> {
  const result = (await handle.db.execute(sql.raw(query))) as { rows: unknown[] };
  return result.rows;
}

export interface HttpListener {
  readonly origin: string;
  close(): Promise<void>;
}

export async function listenHttp(server: FrameworkServer): Promise<HttpListener> {
  const http = createHttpServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      });
      void server.fetch(request).then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
