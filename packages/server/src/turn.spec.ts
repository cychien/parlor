import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAgentUi, type AgentTool } from "@parlor/agent-ui/server";
import {
  ANONYMOUS,
  asId,
  type AuthenticatedPrincipal,
  defineAction,
  type Principal,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createActionRunner } from "./actions.js";
import { AuthFailure, type AuthProvider } from "./auth.js";
import { type Caller, type CallerResolver } from "./caller.js";
import { createServer, type FrameworkServer } from "./create-server.js";
import { createMcpHandler } from "./mcp.js";
import { defaultScope } from "./scope.js";

const alice = asId("user", "alice");

const external: AuthenticatedPrincipal = {
  kind: "agent",
  userId: alice,
  grantId: asId("grant", "oauth:alice:claude"),
  agent: { name: "Claude Code", verified: true },
};
const inline: AuthenticatedPrincipal = {
  kind: "agent",
  userId: alice,
  grantId: asId("grant", "host:h1"),
  agent: { name: "Claude Code", verified: true },
  turn: {
    threadId: asId("thread", "thr-1"),
    turnId: asId("turn", "trn-1"),
    hostId: asId("host", "h1"),
    clientId: "tab-1",
  },
};
const host: AuthenticatedPrincipal = {
  kind: "host",
  userId: alice,
  grantId: asId("grant", "host:h1"),
  hostId: asId("host", "h1"),
};

const TOKENS: Record<string, AuthenticatedPrincipal> = { external, inline, host };

const bearerOf = (request: Request | undefined) =>
  request?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

const callers: CallerResolver = Object.assign(
  async (request: Request): Promise<Caller> => {
    const principal: Principal = TOKENS[bearerOf(request)] ?? ANONYMOUS;
    return {
      principal,
      scope: defaultScope(request, principal),
      audience: "alice",
      clientId: request.headers.get("x-parlor-client") ?? undefined,
    };
  },
  { enforcing: true },
);

const actions = createRegistry({
  deleteTask: defineAction({
    description: "Delete a task by id.",
    input: z.object({ id: z.string() }),
    confirm: true,
    run: ({ id }) => ({ deleted: id }),
  }),
});

describe("a confirmation asked inside a chat turn", () => {
  const ask = async (token: string, headers: Record<string, string> = {}) => {
    const confirm = vi.fn().mockResolvedValue("approved");
    const runner = createActionRunner({
      actions,
      scope: defaultScope,
      callers,
      sync: false,
      confirm,
    });
    await runner.run(
      "deleteTask",
      { id: "t1" },
      new Request("http://app.test/_parlor/mcp", {
        headers: { authorization: `Bearer ${token}`, ...headers },
      }),
      "mcp",
    );
    return confirm.mock.calls[0]![0] as Record<string, unknown>;
  };

  it("carries the thread and pins the card to the tab the prompt came from", async () => {
    const request = await ask("inline", { "x-parlor-client": "proxy-1" });
    expect(request).toMatchObject({
      action: "deleteTask",
      clientId: "tab-1",
      thread: { threadId: "thr-1", turnId: "trn-1" },
      origin: { via: "agent", name: "Claude Code" },
    });
  });

  it("is an ordinary card for an external agent", async () => {
    const request = await ask("external", { "x-parlor-client": "tab-9" });
    expect(request).toMatchObject({ action: "deleteTask", clientId: "tab-9" });
    expect(request).not.toHaveProperty("thread");
  });
});

describe("ui tools called with a turn token", () => {
  const echo: AgentTool = {
    name: "ui_screen",
    description: "Echo the tool context.",
    input: z.object({}),
    readOnly: true,
    run: async (_input, ctx) => ({ origin: ctx.origin }),
  };
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function call(token: string) {
    const real = createAgentUi({ audience: () => "alice" });
    const contextFor = vi
      .spyOn(real, "contextFor")
      .mockImplementation(async (_request, origin) => ({
        scope: "alice",
        origin,
        signal: undefined,
        webOrigin: undefined,
      }));
    const agentUi = { ...real, tools: () => [echo], contextFor };
    const runner = createActionRunner({
      actions,
      scope: defaultScope,
      callers,
      sync: false,
    });
    const handler = createMcpHandler({ actions, runner, agentUi, callers });
    client = new Client({ name: "proxy", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://app.test/_parlor/mcp"), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${token}`);
          return handler.fetch(new Request(input, { ...init, headers }));
        },
      }),
    );
    const result = await client.callTool({ name: "ui_screen", arguments: {} });
    real.close();
    return { result, contextFor };
  }

  it("binds the call to the client the prompt came from", async () => {
    const { result, contextFor } = await call("inline");
    expect(contextFor).toHaveBeenCalledWith(
      expect.anything(),
      { via: "agent", name: "Claude Code" },
      expect.anything(),
      { clientId: "tab-1" },
    );
    expect(result.structuredContent).toEqual({
      origin: { via: "agent", name: "Claude Code" },
    });
  });

  it("leaves an external agent to presence selection", async () => {
    const { contextFor } = await call("external");
    expect(contextFor).toHaveBeenCalledWith(
      expect.anything(),
      { via: "mcp", name: "Claude Code" },
      expect.anything(),
      undefined,
    );
  });
});

describe("the server around a host", () => {
  const servers: FrameworkServer[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) await server.close();
  });

  const provider: AuthProvider = {
    name: "test-auth",
    enforcing: true,
    setup: () => ({}),
    authenticate: (request) => {
      const principal = TOKENS[bearerOf(request)];
      return principal
        ? Promise.resolve(principal)
        : Promise.reject(new AuthFailure("invalid", "Unknown token."));
    },
    challenge: () =>
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="http://app.test/rm"' },
      }),
    revoked: () => new AbortController().signal,
  };

  function serve(): FrameworkServer {
    const server = createServer({ actions, auth: provider });
    servers.push(server);
    return server;
  }

  it("answers a host credential at MCP with the OAuth challenge", async () => {
    const response = await serve().fetch(
      new Request("http://app.test/_parlor/mcp", {
        method: "POST",
        headers: { authorization: "Bearer host", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://app.test/rm"',
    );
  });

  it("still answers a user at MCP with 403", async () => {
    TOKENS.user = { kind: "user", userId: alice, sessionId: "s1" };
    try {
      const response = await serve().fetch(
        new Request("http://app.test/_parlor/mcp", {
          method: "POST",
          headers: { authorization: "Bearer user", "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
    } finally {
      delete TOKENS.user;
    }
  });

  it("names the app in the manifest when the CLI knows its name", async () => {
    vi.stubEnv("PARLOR_APP_NAME", "Hello");
    const manifest = await serve().fetch(
      new Request("http://app.test/_parlor/manifest", {
        headers: { authorization: "Bearer external" },
      }),
    );
    expect(((await manifest.json()) as { app?: unknown }).app).toEqual({ name: "Hello" });
  });

  it("leaves the app out of the manifest otherwise", async () => {
    vi.stubEnv("PARLOR_APP_NAME", "");
    const manifest = await serve().fetch(
      new Request("http://app.test/_parlor/manifest", {
        headers: { authorization: "Bearer external" },
      }),
    );
    expect(await manifest.json()).not.toHaveProperty("app");
  });
});
