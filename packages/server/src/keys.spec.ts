import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ANONYMOUS,
  asId,
  type ConfirmationPolicy,
  defaultConfirmationPolicy,
  defineAction,
  type KeyPrincipal,
  type Principal,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AuthFailure, type AuthProvider } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";
import type { ActionAudit, ServerPlugin } from "./plugin.js";
import type { ScopeResolver } from "./scope.js";

const KEY: KeyPrincipal = {
  kind: "key",
  keyId: asId("key", "k1"),
  scope: "org-a",
  name: 'API key "CI"',
  claims: { role: "viewer" },
};
const TOKENS: Record<string, Principal> = {
  tly_k1: KEY,
  alice: { kind: "user", userId: asId("user", "alice"), sessionId: "s-alice" },
  "alice-agent": {
    kind: "agent",
    userId: asId("user", "alice"),
    grantId: asId("grant", "g-alice"),
    agent: { name: "Claude Code", verified: true },
  },
};

const provider: AuthProvider = {
  name: "key-auth",
  setup: () => ({}),
  enforcing: true,
  authenticate(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) return Promise.resolve(ANONYMOUS);
    const principal = TOKENS[token];
    if (principal) return Promise.resolve(principal);
    return Promise.reject(
      token.startsWith("tly_")
        ? new AuthFailure("invalid", "The API key is invalid.", { challenge: false })
        : new AuthFailure("invalid", "Unknown token."),
    );
  },
  challenge: () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer resource_metadata="http://app.test/rm"' },
    }),
  revoked: () => new AbortController().signal,
};

const ran: string[] = [];
const actions = createRegistry({
  whoami: defineAction({
    description: "Who is calling.",
    input: z.object({}),
    run: (_input, ctx) => ({
      kind: ctx.principal.kind,
      scope: ctx.scope,
      source: ctx.source,
    }),
  }),
  deleteTask: defineAction({
    description: "Delete a task.",
    input: z.object({ id: z.string() }),
    confirm: true,
    run: ({ id }) => {
      ran.push(id);
      return { deleted: id };
    },
  }),
});

const audits: ActionAudit[] = [];
const probe: ServerPlugin = {
  name: "probe",
  setup: () => ({
    actions: createRegistry({
      mine: defineAction({
        description: "A plugin action.",
        input: z.object({}),
        run: () => "ok",
      }),
    }),
    routes: [
      {
        method: "GET",
        path: "/me",
        access: ["user", "host"],
        handle: async (_request, caller) =>
          Response.json({ kind: caller.principal.kind }),
      },
    ],
    audit: (record) => audits.push(record),
  }),
};

let database: DatabaseHandle;
const servers: FrameworkServer[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute("select 1");
}, 30_000);
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  ran.length = 0;
  audits.length = 0;
});
afterAll(async () => {
  await database.close();
});

function serve(
  options: {
    readonly scope?: ScopeResolver;
    readonly confirmation?: ConfirmationPolicy;
  } = {},
): FrameworkServer {
  const server = createServer({
    actions,
    auth: provider,
    plugins: [probe],
    database: {
      read: () => database.read(),
      transaction: (run) => database.transaction(run),
      listen: (channel, handler) => database.listen(channel, handler),
    },
    agentUi: { confirmTimeoutMs: 60_000 },
    ...options,
  });
  server.installUiManifest?.(() => ({
    protocol: 1,
    app: { id: "app", name: "App" },
    routes: [{ path: "/", description: "Home.", params: [], views: [] }],
    views: [],
  }));
  servers.push(server);
  return server;
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
});
const get = (server: FrameworkServer, path: string, token = "tly_k1") =>
  server.fetch(new Request(`http://app.test${path}`, { headers: headers(token) }));
const post = (
  server: FrameworkServer,
  path: string,
  body: unknown = {},
  token = "tly_k1",
) =>
  server.fetch(
    new Request(`http://app.test${path}`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

async function connect(server: FrameworkServer, token = "tly_k1"): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/_parlor/mcp"), {
      fetch: (input, init) =>
        server.fetch(
          new Request(input, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers).entries()),
              authorization: `Bearer ${token}`,
            },
          }),
        ),
    }),
  );
  clients.push(client);
  return client;
}

const toolBody = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { text: string }[])[0]!.text) as unknown;

describe("an API key principal", () => {
  it("reaches the manifest, actions and MCP, and no surface that assumes a user", async () => {
    const server = serve();
    const manifest = (await (await get(server, "/_parlor/manifest")).json()) as {
      actions?: unknown[];
    };
    expect({
      manifestHasActions: manifest.actions !== undefined,
      actions: (await post(server, "/_parlor/actions/whoami")).status,
      mcp: (await post(server, "/_parlor/mcp", INITIALIZE)).status,
      sync: (await get(server, "/_parlor/sync?cursor=0")).status,
      syncStream: (await get(server, "/_parlor/sync/stream")).status,
      ui: (await post(server, "/_parlor/ui")).status,
      pluginRoute: (await get(server, "/_parlor/probe/me")).status,
      pluginActions: (await post(server, "/_parlor/probe/actions/mine")).status,
    }).toEqual({
      manifestHasActions: true,
      actions: 200,
      mcp: 200,
      sync: 403,
      syncStream: 403,
      ui: 403,
      pluginRoute: 403,
      pluginActions: 403,
    });
  });

  it("acts in its own scope, as http over /actions and as mcp over MCP", async () => {
    const server = serve();
    const viaHttp = (await (await post(server, "/_parlor/actions/whoami")).json()) as {
      data: unknown;
    };
    expect(viaHttp.data).toEqual({ kind: "key", scope: "org-a", source: "http" });

    const client = await connect(server);
    expect(
      (await client.callTool({ name: "whoami", arguments: {} })).structuredContent,
    ).toEqual({ kind: "key", scope: "org-a", source: "mcp" });
  });

  it("is refused when the scope resolver answers a scope other than the key's", async () => {
    const server = serve({ scope: () => "org-b" });
    const refused = await post(server, "/_parlor/actions/whoami");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "forbidden" } });
    const mcp = await post(server, "/_parlor/mcp", INITIALIZE);
    expect(mcp.status).toBe(403);
    expect(mcp.headers.get("www-authenticate")).toBeNull();
  });

  it("is refused a confirm action at once on /actions and on MCP, and the action never runs", async () => {
    const server = serve();
    const viaHttp = await post(server, "/_parlor/actions/deleteTask", { id: "t1" });
    expect(viaHttp.status).toBe(503);
    expect(await viaHttp.json()).toMatchObject({
      error: {
        code: "confirmation_unavailable",
        message: expect.stringContaining("nobody can give it for this caller"),
      },
    });

    const client = await connect(server);
    const viaMcp = await client.callTool({ name: "deleteTask", arguments: { id: "t2" } });
    expect(viaMcp.isError).toBe(true);
    expect(toolBody(viaMcp)).toMatchObject({
      error: { code: "confirmation_unavailable" },
    });

    expect(ran).toEqual([]);
    expect(
      audits
        .filter((record) => record.action === "deleteTask")
        .map(({ source, stage, outcome, confirmation }) => ({
          source,
          stage,
          outcome,
          confirmation,
        })),
    ).toEqual([
      {
        source: "http",
        stage: "refused",
        outcome: "confirmation_unavailable",
        confirmation: undefined,
      },
      {
        source: "mcp",
        stage: "refused",
        outcome: "confirmation_unavailable",
        confirmation: undefined,
      },
    ]);
  });

  it("runs a confirm action an app's policy lets through, recorded as waived", async () => {
    const server = serve({
      confirmation: (call) =>
        call.principal.kind === "key" ? "proceed" : defaultConfirmationPolicy(call),
    });
    const viaMcp = await (
      await connect(server)
    ).callTool({
      name: "deleteTask",
      arguments: { id: "t3" },
    });
    expect(viaMcp.isError).toBeFalsy();
    const viaHttp = await post(server, "/_parlor/actions/deleteTask", { id: "t4" });
    expect(viaHttp.status).toBe(200);
    const byAlice = await post(
      server,
      "/_parlor/actions/deleteTask",
      { id: "t5" },
      "alice",
    );
    expect(byAlice.status).toBe(200);

    expect(ran).toEqual(["t3", "t4", "t5"]);
    expect(
      audits
        .filter((record) => record.action === "deleteTask")
        .map(({ principal, source, confirmation }) => [
          principal.kind,
          source,
          confirmation,
        ]),
    ).toEqual([
      ["key", "mcp", "waived"],
      ["key", "http", "waived"],
      ["user", "ui", undefined],
    ]);
  });

  it("gets an MCP session without the screen: no ui tools, manifest resource or screen instructions", async () => {
    const server = serve();
    const agent = await connect(server, "alice-agent");
    const agentTools = (await agent.listTools()).tools.map((tool) => tool.name);
    expect(agentTools).toEqual(expect.arrayContaining(["whoami", "ui_screen"]));
    expect(
      (await agent.listResources()).resources.map((resource) => resource.name),
    ).toEqual(["ui-manifest"]);
    expect(agent.getInstructions()).toContain("as the signed-in user");
    expect(agent.getInstructions()).toContain("ui_screen");

    const key = await connect(server);
    const keyTools = (await key.listTools()).tools;
    expect(keyTools.map((tool) => tool.name)).toEqual(["whoami", "deleteTask"]);
    expect((await key.listResources()).resources).toEqual([]);
    expect(key.getInstructions()).toBe(
      'These tools belong to this app at http://app.test. They act only on this app, as API key "CI"; any other app\'s tools are a separate server.',
    );
    expect(keyTools.find((tool) => tool.name === "deleteTask")?.description).toBe(
      "Delete a task. It needs a person's approval, which nobody can give for this caller, so a call fails with confirmation_unavailable without running.",
    );
    const agentDelete = (await agent.listTools()).tools.find(
      (tool) => tool.name === "deleteTask",
    );
    expect(agentDelete?.description).toContain(
      "the user must approve it in the app first",
    );
  });

  it("answers an invalid key with a plain 401 and no OAuth challenge", async () => {
    const server = serve();
    const badKey = await post(server, "/_parlor/mcp", INITIALIZE, "tly_revoked");
    expect(badKey.status).toBe(401);
    expect(badKey.headers.get("www-authenticate")).toBeNull();
    expect(await badKey.json()).toMatchObject({ error: { code: "unauthenticated" } });

    const badToken = await post(server, "/_parlor/mcp", INITIALIZE, "expired-oauth");
    expect(badToken.status).toBe(401);
    expect(badToken.headers.get("www-authenticate")).not.toBeNull();
  });
});
