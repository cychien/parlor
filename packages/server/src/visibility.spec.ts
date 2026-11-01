import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ActionError,
  ANONYMOUS,
  asId,
  defineAction,
  encodeReadRequests,
  type Principal,
  REFRESH_HEADER,
  userOf,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AuthFailure, type AuthProvider } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";
import type { ServerPlugin } from "./plugin.js";
import type { ActionVisibility } from "./visibility.js";

const TOKENS: Record<string, Principal> = {
  admin: { kind: "user", userId: asId("user", "admin"), sessionId: "s-admin" },
  viewer: { kind: "user", userId: asId("user", "viewer"), sessionId: "s-viewer" },
  "viewer-agent": {
    kind: "agent",
    userId: asId("user", "viewer"),
    grantId: asId("grant", "g-viewer"),
    agent: { name: "Claude Code", verified: true },
  },
};

const provider: AuthProvider = {
  name: "test-auth",
  setup: () => ({}),
  enforcing: true,
  authenticate(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) return Promise.resolve(ANONYMOUS);
    const principal = TOKENS[token];
    return principal
      ? Promise.resolve(principal)
      : Promise.reject(new AuthFailure("invalid", "Unknown token."));
  },
  challenge: () => new Response(null, { status: 401 }),
  revoked: () => new AbortController().signal,
};

const ran: string[] = [];
const actions = createRegistry({
  listTasks: defineAction({
    description: "List tasks.",
    input: z.object({}),
    reads: ["tasks"],
    run: () => ["t1"],
  }),
  listSalaries: defineAction({
    description: "List salaries.",
    input: z.object({}),
    reads: ["tasks"],
    run: () => {
      ran.push("listSalaries");
      return ["$"];
    },
  }),
  renameTask: defineAction({
    description: "Rename a task.",
    input: z.object({ id: z.string() }),
    writes: ["tasks"],
    run: ({ id }) => ({ id }),
  }),
});

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
  }),
};

const servers: FrameworkServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  ran.length = 0;
});

function serve(visible: ActionVisibility): FrameworkServer {
  const server = createServer({
    actions,
    auth: provider,
    plugins: [probe],
    sync: false,
    agentUi: false,
    visible,
  });
  servers.push(server);
  return server;
}

const viewerSeesNoSalaries: ActionVisibility = (caller) => {
  const viewer = userOf(caller.principal) === "viewer";
  return (name) => !(viewer && name === "listSalaries");
};

const post = (
  server: FrameworkServer,
  path: string,
  token: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  server.fetch(
    new Request(`http://app.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

async function connect(server: FrameworkServer, token: string): Promise<Client> {
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

describe("createServer({ visible })", () => {
  it("leaves a hidden action out of the manifest and MCP tools/list, for that caller only", async () => {
    const server = serve(viewerSeesNoSalaries);
    const names = async (token: string) => {
      const response = await server.fetch(
        new Request("http://app.test/_parlor/manifest", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const manifest = (await response.json()) as { actions: { name: string }[] };
      return manifest.actions.map((action) => action.name);
    };
    expect(await names("admin")).toEqual(["listTasks", "listSalaries", "renameTask"]);
    expect(await names("viewer")).toEqual(["listTasks", "renameTask"]);

    const agent = await connect(server, "viewer-agent");
    expect((await agent.listTools()).tools.map((tool) => tool.name)).toEqual([
      "listTasks",
      "renameTask",
    ]);
  });

  it("answers a call to a hidden action as it answers one to an action that does not exist", async () => {
    const server = serve(viewerSeesNoSalaries);
    const hidden = await post(server, "/_parlor/actions/listSalaries", "viewer");
    const missing = await post(server, "/_parlor/actions/nope", "viewer");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({
      error: { code: "not_found", message: 'Unknown action "listSalaries"' },
    });
    expect(missing.status).toBe(404);

    const agent = await connect(server, "viewer-agent");
    const viaHidden = await agent
      .callTool({ name: "listSalaries", arguments: {} })
      .catch((error: unknown) => error);
    const viaMissing = await agent
      .callTool({ name: "nope", arguments: {} })
      .catch((error: unknown) => error);
    expect((viaHidden as Error).message).toMatch(/Tool listSalaries not found/);
    expect((viaMissing as Error).message).toMatch(/Tool nope not found/);
    expect(JSON.stringify(viaHidden).replace("listSalaries", "nope")).toBe(
      JSON.stringify(viaMissing),
    );
    expect(ran).toEqual([]);

    const admin = await post(server, "/_parlor/actions/listSalaries", "admin");
    expect(admin.status).toBe(200);
    expect(ran).toEqual(["listSalaries"]);
  });

  it("answers a hidden read on a write's refresh as it answers an unknown one, and asks visible once per request", async () => {
    let asked = 0;
    const server = serve((caller, request) => {
      asked += 1;
      return viewerSeesNoSalaries(caller, request);
    });
    const answer = await post(
      server,
      "/_parlor/actions/renameTask",
      "viewer",
      { id: "t1" },
      {
        [REFRESH_HEADER]: encodeReadRequests([
          ["listTasks", {}],
          ["listSalaries", {}],
          ["doesNotExist", {}],
        ]),
      },
    );
    expect(await answer.json()).toMatchObject({
      data: { id: "t1" },
      refreshed: [{ data: ["t1"] }, null, null],
    });
    expect(asked).toBe(1);
    expect(ran).toEqual([]);
  });

  it("answers a refusal from visible with its code on the manifest, actions and MCP alike", async () => {
    const server = serve(() => {
      throw new ActionError("forbidden", "Suspended.");
    });
    const body = { error: { code: "forbidden", message: "Suspended." } };
    const manifest = await server.fetch(
      new Request("http://app.test/_parlor/manifest", {
        headers: { authorization: "Bearer viewer" },
      }),
    );
    const call = await post(server, "/_parlor/actions/listTasks", "viewer");
    const mcp = await post(
      server,
      "/_parlor/mcp",
      "viewer-agent",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { accept: "application/json, text/event-stream" },
    );
    for (const response of [manifest, call, mcp]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(body);
    }
  });

  it("never filters a plugin's actions", async () => {
    const server = serve(() => () => false);
    const plugin = await post(server, "/_parlor/probe/actions/mine", "admin");
    expect(plugin.status).toBe(200);
    expect(await plugin.json()).toMatchObject({ data: "ok" });
    const app = await post(server, "/_parlor/actions/listTasks", "admin");
    expect(app.status).toBe(404);
  });
});
