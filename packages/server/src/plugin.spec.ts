import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { UNROUTED_HEADER } from "@parlor/agent-ui";
import {
  ActionError,
  ANONYMOUS,
  type AuthenticatedPrincipal,
  asId,
  type DataProvider,
  defineAction,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuthProvider } from "./auth.js";
import {
  createServer,
  type FrameworkServer,
  type ServerOptions,
} from "./create-server.js";
import {
  type ActionAudit,
  type AnyPluginRoute,
  type PluginHost,
  pluginRoute,
  type ServerPlugin,
} from "./plugin.js";

const alice = asId("user", "alice");

const TOKENS: Record<string, AuthenticatedPrincipal> = {
  alice: { kind: "user", userId: alice, sessionId: "s-alice" },
  "alice-agent": {
    kind: "agent",
    userId: alice,
    grantId: asId("grant", "g"),
    agent: { name: "Claude Code", verified: true },
  },
  "alice-host": {
    kind: "host",
    userId: alice,
    grantId: asId("grant", "g"),
    hostId: asId("host", "mac"),
  },
};

const testAuth: AuthProvider = {
  name: "test-auth",
  setup: () => ({}),
  enforcing: true,
  authenticate(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    return Promise.resolve(token ? (TOKENS[token] ?? ANONYMOUS) : ANONYMOUS);
  },
  challenge: () => new Response(null, { status: 401 }),
  revoked: () => new AbortController().signal,
};

const items = { _: { name: "parlor_demo_items" } };

function demoPlugin(log: { audits: ActionAudit[]; closed: number }): ServerPlugin {
  return {
    name: "demo",
    migrations: [
      {
        id: "demo/0001_items",
        sql: "create table parlor_demo_items (id serial primary key, title text not null)",
      },
    ],
    setup: () => ({
      actions: createRegistry({
        add: defineAction({
          description: "Add an item.",
          input: z.object({ title: z.string() }),
          writes: [items],
          run: async ({ title }, ctx) => {
            const db = ctx.db as DatabaseHandle["db"];
            await db.execute(
              sql`insert into parlor_demo_items (title) values (${title})`,
            );
            return { title, by: ctx.principal.kind };
          },
        }),
      }),
      channel: { event: "demo", connect: () => () => {} },
      routes: [
        pluginRoute({
          method: "POST",
          path: "/stream",
          access: ["host"],
          handle: (_request, caller) =>
            Promise.resolve(Response.json({ host: caller.principal.hostId })),
        }),
        pluginRoute({
          method: "GET",
          path: "/open",
          access: ["anonymous", "user"],
          handle: (_request, caller) =>
            Promise.resolve(Response.json({ kind: caller.principal.kind })),
        }),
        {
          method: "GET",
          path: "/.well-known/demo",
          access: "public",
          handle: () => Promise.resolve(Response.json({ public: true })),
        },
      ],
      audit: (record) => log.audits.push(record),
      close: () => {
        log.closed += 1;
      },
    }),
  };
}

const appActions = createRegistry({
  hello: defineAction({
    description: "Say hello.",
    input: z.object({ name: z.string() }),
    run: ({ name }) => `hello ${name}`,
  }),
  fail: defineAction({
    description: "Always fails.",
    input: z.object({}),
    run: () => {
      throw new Error("boom");
    },
  }),
  remove: defineAction({
    description: "Remove something.",
    input: z.object({ id: z.string() }),
    confirm: true,
    run: ({ id }) => id,
  }),
});

let shared: DatabaseHandle;
const servers: FrameworkServer[] = [];
const closers: (() => Promise<void>)[] = [];

// PGlite starts on its first query, so that happens here, outside any test's timeout.
beforeAll(async () => {
  shared = await createDatabase({ dataDir: "memory://" });
  await shared.db.execute(sql`select 1`);
}, 30_000);

afterAll(async () => {
  await shared.close();
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const server of servers.splice(0)) await server.close();
});

/** An empty database: one PGlite per file, its public schema dropped for each test. */
async function database(): Promise<DatabaseHandle> {
  await shared.db.execute(sql`drop schema public cascade`);
  await shared.db.execute(sql`create schema public`);
  return shared;
}

const lend = (handle: DatabaseHandle): DataProvider => ({
  read: () => handle.read(),
  transaction: (run) => handle.transaction(run),
  listen: (channel, handler) => handle.listen(channel, handler),
});

function serve(options: Partial<ServerOptions<typeof appActions>>) {
  const server = createServer({ actions: appActions, ...options });
  servers.push(server);
  return server;
}

function call(
  server: FrameworkServer,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  return server.fetch(
    new Request(`http://app.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as unknown };
}

async function rows(handle: DatabaseHandle, query: string): Promise<unknown[]> {
  const result = (await handle.db.execute(sql.raw(query))) as { rows: unknown[] };
  return result.rows;
}

describe("server plugins", () => {
  it("records a sync event a plugin announces for a write outside an action", async () => {
    const handle = await database();
    let host: PluginHost | undefined;
    const plugin: ServerPlugin = {
      name: "announcer",
      setup: (given) => {
        host = given;
        return {};
      },
    };
    serve({ database: lend(handle), plugins: [plugin] });
    await host!.announce("scope-a", [["parlor_announcer_items", "1"]]);
    expect(await rows(handle, "select scope, tags from sync_events")).toEqual([
      { scope: "scope-a", tags: [["parlor_announcer_items", "1"]] },
    ]);
  });

  it("commits an announced event with the caller's transaction, and drops it on rollback", async () => {
    const handle = await database();
    let host: PluginHost | undefined;
    serve({
      database: lend(handle),
      plugins: [{ name: "announcer", setup: (given) => ((host = given), {}) }],
    });
    await host!.announce("scope-a", [["warmup"]]);
    const own = lend(handle);

    await own
      .transaction(async (tx) => {
        await host!.announce("scope-a", [["parlor_announcer_items", "rolled-back"]], tx);
        throw new Error("rollback");
      })
      .catch(() => {});
    await own.transaction((tx) =>
      host!.announce("scope-a", [["parlor_announcer_items", "kept"]], tx),
    );

    expect(await rows(handle, "select tags from sync_events order by version")).toEqual([
      { tags: [["warmup"]] },
      { tags: [["parlor_announcer_items", "kept"]] },
    ]);
  });

  it("does nothing when a plugin announces with sync off", async () => {
    const handle = await database();
    let host: PluginHost | undefined;
    serve({
      database: lend(handle),
      sync: false,
      plugins: [{ name: "announcer", setup: (given) => ((host = given), {}) }],
    });
    await host!.announce("scope-a", [["parlor_announcer_items", "1"]]);
    expect(
      await rows(handle, "select to_regclass('sync_events') is null as missing"),
    ).toEqual([{ missing: true }]);
  });

  it("migrates before the auth provider sees the first request", async () => {
    const handle = await database();
    const provider: AuthProvider = {
      ...testAuth,
      name: "table-auth",
      migrations: [
        {
          id: "table-auth/0001_tokens",
          sql: "create table parlor_table_auth_tokens (token text primary key)",
        },
      ],
      async authenticate(request) {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
        await handle.db.execute(
          sql`select 1 from parlor_table_auth_tokens where token = ${token ?? ""}`,
        );
        return testAuth.authenticate(request);
      },
    };
    const server = serve({ database: lend(handle), auth: provider });
    const response = await call(server, "GET", "/_parlor/manifest", "alice");
    expect(response.status).toBe(200);
  });

  it("serves plugin actions through the runner, at the plugin's own path", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const handle = await database();
    const server = serve({ database: lend(handle), plugins: [demoPlugin(log)] });
    expect(
      await json(
        await call(server, "POST", "/_parlor/demo/actions/add", undefined, {
          title: "a",
        }),
      ),
    ).toEqual({
      status: 200,
      body: { data: { title: "a", by: "anonymous" }, tags: [] },
    });
    expect(await rows(handle, "select title from parlor_demo_items")).toEqual([
      { title: "a" },
    ]);
  });

  it("keeps plugin actions off MCP and off the manifest", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = serve({
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://app.test/_parlor/mcp"), {
        fetch: (input, init) => server.fetch(new Request(input, init)),
      }),
    );
    closers.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain("add");
    const manifest = (await json(await call(server, "GET", "/_parlor/manifest")))
      .body as {
      actions: { name: string }[];
    };
    expect(manifest.actions.map((action) => action.name)).toEqual([
      "hello",
      "fail",
      "remove",
    ]);
  });

  it("lets users and hosts call plugin actions, never an agent", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = serve({
      auth: testAuth,
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    const add = (token?: string) =>
      call(server, "POST", "/_parlor/demo/actions/add", token, { title: "x" });
    expect((await json(await add("alice-host"))).body).toMatchObject({
      data: { by: "host" },
    });
    expect((await add("alice")).status).toBe(200);
    expect(await json(await add("alice-agent"))).toMatchObject({
      status: 403,
      body: { error: { code: "forbidden" } },
    });
    expect(await json(await add())).toMatchObject({
      status: 401,
      body: { error: { code: "unauthenticated" } },
    });
  });

  it("applies each migration once, even when two servers start together", async () => {
    const handle = await database();
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const first = serve({ database: lend(handle), plugins: [demoPlugin(log)] });
    const second = serve({ database: lend(handle), plugins: [demoPlugin(log)] });
    const add = (server: FrameworkServer) =>
      call(server, "POST", "/_parlor/demo/actions/add", undefined, { title: "x" });
    const answers = await Promise.all([add(first), add(second)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await rows(handle, "select id from parlor_migrations")).toEqual([
      { id: "demo/0001_items" },
    ]);
  });

  it("hands each route exactly the caller its access list allows", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = serve({
      auth: testAuth,
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    expect(
      await json(await call(server, "POST", "/_parlor/demo/stream", "alice-host")),
    ).toEqual({
      status: 200,
      body: { host: "mac" },
    });
    expect((await call(server, "POST", "/_parlor/demo/stream", "alice")).status).toBe(
      403,
    );
    expect((await call(server, "POST", "/_parlor/demo/stream")).status).toBe(401);
    expect((await call(server, "GET", "/_parlor/demo/open")).status).toBe(401);
    expect(await json(await call(server, "GET", "/.well-known/demo"))).toEqual({
      status: 200,
      body: { public: true },
    });
  });

  it("admits an anonymous caller only where a route lists it and auth is not enforced", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = serve({
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    expect(await json(await call(server, "GET", "/_parlor/demo/open"))).toEqual({
      status: 200,
      body: { kind: "anonymous" },
    });
    expect((await call(server, "POST", "/_parlor/demo/stream")).status).toBe(401);
  });

  it("advertises the plugin's channel on the sync stream", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = serve({
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    const controller = new AbortController();
    closers.push(() => Promise.resolve(controller.abort()));
    const response = await server.fetch(
      new Request("http://app.test/_parlor/sync/stream?since=", {
        headers: { accept: "text/event-stream", "x-parlor-client": "tab" },
        signal: controller.signal,
      }),
    );
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("\n\n"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"capabilities":["ui","demo"]');
  });

  it("audits every action call once, whatever its outcome", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = serve({
      auth: testAuth,
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    const app = (name: string, token: string, body: unknown) =>
      call(server, "POST", `/_parlor/actions/${name}`, token, body);
    await app("hello", "alice", { name: "Ada" });
    await app("hello", "alice", { name: 42 });
    await app("hello", "alice-host", { name: "Ada" });
    await app("fail", "alice", {});
    await app("remove", "alice-agent", { id: "r1" });

    expect(
      log.audits.map(({ action, principal, source, stage, outcome, confirmation }) => ({
        action,
        kind: principal.kind,
        source,
        stage,
        outcome,
        ...(confirmation ? { confirmation } : {}),
      })),
    ).toEqual([
      { action: "hello", kind: "user", source: "ui", stage: "ran", outcome: "ok" },
      {
        action: "hello",
        kind: "user",
        source: "ui",
        stage: "refused",
        outcome: "invalid_input",
      },
      {
        action: "hello",
        kind: "host",
        source: "http",
        stage: "refused",
        outcome: "forbidden",
      },
      { action: "fail", kind: "user", source: "ui", stage: "ran", outcome: "internal" },
      {
        action: "remove",
        kind: "agent",
        source: "mcp",
        stage: "refused",
        outcome: "confirmation_unavailable",
        confirmation: "unavailable",
      },
    ]);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode('{"name":"Ada"}')),
    );
    expect(log.audits[0]?.inputDigest).toBe(
      [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
  });

  it("closes each plugin with the server", async () => {
    const log = { audits: [] as ActionAudit[], closed: 0 };
    const server = createServer({
      actions: appActions,
      database: lend(await database()),
      plugins: [demoPlugin(log)],
    });
    await server.close();
    expect(log.closed).toBe(1);
  });

  it("refuses a plugin it cannot install", () => {
    const named = (name: string, id = `${name}/0001_x`): ServerPlugin => ({
      name,
      migrations: [{ id: id as `${string}/${number}_${string}`, sql: "select 1" }],
      setup: () => ({}),
    });
    const install = (plugins: ServerPlugin[]) => () =>
      createServer({
        actions: appActions,
        database: { read: () => 0, transaction: (run) => run(0) },
        plugins,
      });
    expect(install([named("sync")])).toThrow(/cannot name a plugin/);
    expect(install([named("demo"), named("demo")])).toThrow(/Two plugins/);
    expect(install([named("demo", "other/0001_x")])).toThrow(/must start with "demo\/"/);
    expect(() => createServer({ actions: appActions, plugins: [named("demo")] })).toThrow(
      /needs a database/,
    );
  });
});

describe("a server without plugins", () => {
  it("adds no query and no table to an action call", async () => {
    const handle = await database();
    let reads = 0;
    let transactions = 0;
    const server = serve({
      database: {
        read: () => (reads++, handle.read()),
        transaction: (run) => (transactions++, handle.transaction(run)),
      },
    });
    await call(server, "POST", "/_parlor/actions/hello", undefined, { name: "warm" });
    reads = 0;
    transactions = 0;
    const answer = await call(server, "POST", "/_parlor/actions/hello", undefined, {
      name: "x",
    });
    expect(answer.status).toBe(200);
    expect({ reads, transactions }).toEqual({ reads: 1, transactions: 0 });
    expect(await rows(handle, "select to_regclass('parlor_migrations') as t")).toEqual([
      { t: null },
    ]);
  });

  it("keeps an ActionError thrown by a plugin route as its own status", async () => {
    const server = serve({
      plugins: [
        {
          name: "strict",
          setup: () => ({
            routes: [
              {
                method: "GET",
                path: "/x",
                access: "public",
                handle: () =>
                  Promise.reject(new ActionError("not_found", "Nothing here.")),
              },
            ],
          }),
        },
      ],
    });
    expect((await call(server, "GET", "/_parlor/strict/x")).status).toBe(404);
  });
});

describe("absolute plugin routes", () => {
  const route = (
    method: "GET" | "POST",
    path: `/${string}`,
    absolute = true,
  ): AnyPluginRoute => ({
    method,
    path,
    absolute,
    access: "public",
    handle: () => Promise.resolve(Response.json({ method, path })),
  });
  const plugin = (name: string, routes: AnyPluginRoute[]): ServerPlugin => ({
    name,
    setup: () => ({ routes }),
  });
  const manifest =
    (...paths: string[]) =>
    () => ({
      protocol: 1 as const,
      app: { id: "dev.parlor.test", name: "Test" },
      routes: paths.map((path) => ({ path, params: [], views: [] })),
      views: [],
    });

  it("serves an absolute route at the origin root with its access, and not under the prefix", async () => {
    const server = serve({
      auth: testAuth,
      plugins: [
        plugin("payments", [
          route("POST", "/api/payment/webhook"),
          pluginRoute({
            method: "GET",
            path: "/api/payment/return",
            absolute: true,
            access: ["user"],
            handle: (_request, caller) =>
              Promise.resolve(Response.json({ user: caller.principal.userId })),
          }),
        ]),
      ],
    });
    expect(await json(await call(server, "POST", "/api/payment/webhook"))).toEqual({
      status: 200,
      body: { method: "POST", path: "/api/payment/webhook" },
    });
    expect(await json(await call(server, "GET", "/api/payment/return", "alice"))).toEqual(
      { status: 200, body: { user: "alice" } },
    );
    expect((await call(server, "GET", "/api/payment/return")).status).toBe(401);
    const prefixed = await call(server, "POST", "/_parlor/payments/api/payment/webhook");
    expect(prefixed.status).toBe(404);
    expect(prefixed.headers.get(UNROUTED_HEADER)).toBe("1");
  });

  it("marks the 404 for a request no route matches, but not a route's own 404", async () => {
    const server = serve({
      plugins: [
        plugin("strict", [
          {
            method: "GET",
            path: "/missing",
            absolute: true,
            access: "public",
            handle: () => Promise.reject(new ActionError("not_found", "Nothing here.")),
          },
        ]),
      ],
    });
    const own = await call(server, "GET", "/missing");
    expect(own.status).toBe(404);
    expect(own.headers.get(UNROUTED_HEADER)).toBeNull();
    for (const [method, path] of [
      ["GET", "/tasks/42"],
      ["POST", "/missing"],
      ["GET", "/_parlor/nothing"],
    ] as const) {
      const unrouted = await call(server, method, path);
      expect(unrouted.status).toBe(404);
      expect(unrouted.headers.get(UNROUTED_HEADER)).toBe("1");
      expect(await unrouted.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("refuses at startup an absolute route the framework or another plugin already serves", () => {
    const install = (plugins: ServerPlugin[], basePath?: string) => () =>
      createServer({ actions: appActions, plugins, basePath });
    expect(install([plugin("pay", [route("GET", "/_parlor")])])).toThrow(
      /is under \/_parlor, which the framework serves/,
    );
    expect(install([plugin("pay", [route("POST", "/_parlor/sync/stream")])])).toThrow(
      /is under \/_parlor/,
    );
    expect(install([plugin("pay", [route("GET", "/api/x")])], "/api")).toThrow(
      /is under \/api/,
    );
    expect(install([plugin("pay", [route("GET", "/_parlorish")])])).not.toThrow();
    expect(install([plugin("pay", [route("GET", "/pay/:id")])])).toThrow(
      /must be a static path/,
    );
    expect(install([plugin("pay", [route("GET", "/pay/**")])])).toThrow(
      /must be a static path/,
    );
    expect(
      install([
        plugin("pay", [route("POST", "/api/hook")]),
        plugin("shop", [route("POST", "/api/hook")]),
      ]),
    ).toThrow(/The "pay" and "shop" plugins both serve POST \/api\/hook/);
    expect(
      install([plugin("pay", [route("GET", "/api/hook"), route("GET", "/api/hook")])]),
    ).toThrow(/The "pay" plugin serves GET \/api\/hook twice/);
    expect(
      install([plugin("pay", [route("GET", "/api/hook"), route("POST", "/api/hook")])]),
    ).not.toThrow();
    expect(
      install([
        plugin("pay", [route("GET", "/hook", false)]),
        plugin("shop", [route("GET", "/hook", false)]),
      ]),
    ).not.toThrow();
  });

  it.each([true, false])(
    "refuses an absolute GET route a page route would take a document request for (agent UI %s)",
    (agentUi) => {
      const server = serve({
        agentUi: agentUi ? {} : false,
        plugins: [
          plugin("pay", [
            route("GET", "/api/payment/return"),
            route("POST", "/payment/webhook"),
          ]),
        ],
      });
      const install = (source: ReturnType<typeof manifest>) => () =>
        server.installUiManifest?.(source);
      expect(install(manifest("/", "/payment/$orderId", "/api/payment"))).not.toThrow();
      expect(install(manifest("/api/$section/return"))).toThrow(
        /absolute route GET \/api\/payment\/return is also matched by the page route \/api\/\$section\/return/,
      );
      expect(install(manifest("/$"))).toThrow(/page route \/\$/);
      expect(install(() => undefined)).not.toThrow();
    },
  );
});
