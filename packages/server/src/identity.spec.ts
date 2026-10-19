import {
  ANONYMOUS,
  type AuthenticatedPrincipal,
  asId,
  defineAction,
  type Principal,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AuthFailure, type AuthProvider } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";

const alice = asId("user", "alice");
const bob = asId("user", "bob");

const TOKENS: Record<string, AuthenticatedPrincipal> = {
  alice: { kind: "user", userId: alice, sessionId: "s-alice" },
  bob: { kind: "user", userId: bob, sessionId: "s-bob" },
  "alice-agent": {
    kind: "agent",
    userId: alice,
    grantId: asId("grant", "g-alice"),
    agent: { name: "Claude Code", verified: true },
  },
  "alice-host": {
    kind: "host",
    userId: alice,
    grantId: asId("grant", "g-host"),
    hostId: asId("host", "mac"),
  },
};

function testAuth() {
  const sessions = new Map<string, AbortController>();
  let calls = 0;
  const keyOf = (principal: AuthenticatedPrincipal) =>
    `${principal.kind}:${principal.userId}`;
  const provider: AuthProvider = {
    enforcing: true,
    authenticate(request) {
      calls += 1;
      const header = request.headers.get("authorization");
      if (!header) return Promise.resolve(ANONYMOUS);
      const principal = TOKENS[header.replace(/^Bearer /, "")];
      if (!principal) return Promise.reject(new AuthFailure("invalid", "Unknown token."));
      return Promise.resolve(principal);
    },
    challenge: () =>
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="http://app.test/rm"' },
      }),
    revoked(principal) {
      const key = keyOf(principal);
      let controller = sessions.get(key);
      if (!controller) sessions.set(key, (controller = new AbortController()));
      return controller.signal;
    },
  };
  return {
    provider,
    revoke: (token: string) => sessions.get(keyOf(TOKENS[token]!))?.abort(),
    get calls() {
      return calls;
    },
  };
}

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
    run: (_input, ctx) => ({ principal: ctx.principal.kind }),
  }),
  deleteTask: defineAction({
    description: "Delete a task by id.",
    input: z.object({ id: z.string() }),
    confirm: true,
    run: ({ id }) => ({ deleted: id }),
  }),
});

let database: DatabaseHandle;
let auth: ReturnType<typeof testAuth>;
const servers: FrameworkServer[] = [];
const closers: (() => void)[] = [];

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute("select 1");
}, 30_000);
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) await server.close();
});
afterAll(async () => {
  await database.close();
});

function serve(scope?: (request: Request, principal: Principal) => string) {
  auth = testAuth();
  const server = createServer({
    actions,
    auth: auth.provider,
    database: {
      read: () => database.read(),
      transaction: (run) => database.transaction(run),
      listen: (channel, handler) => database.listen(channel, handler),
    },
    agentUi: { confirmTimeoutMs: 2000 },
    ...(scope ? { scope } : {}),
  });
  servers.push(server);
  return server;
}

interface Call {
  readonly token?: string | undefined;
  readonly clientId?: string | undefined;
  readonly source?: string | undefined;
}

function post(server: FrameworkServer, path: string, body: unknown, call: Call = {}) {
  return server.fetch(
    new Request(`http://app.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
        ...(call.clientId ? { "x-parlor-client": call.clientId } : {}),
        ...(call.source ? { "x-parlor-source": call.source } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function json(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

interface Frame {
  readonly event: string;
  readonly data: string;
}

async function openStream(server: FrameworkServer, call: Call) {
  const controller = new AbortController();
  closers.push(() => controller.abort());
  const response = await server.fetch(
    new Request("http://app.test/_parlor/sync/stream?since=", {
      headers: {
        accept: "text/event-stream",
        ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
        ...(call.clientId ? { "x-parlor-client": call.clientId } : {}),
      },
      signal: controller.signal,
    }),
  );
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            if (line.startsWith("data: ")) data.push(line.slice(6));
          }
          if (data.length > 0) frames.push({ event, data: data.join("\n") });
          for (const wake of waiters) wake();
        }
      }
    } catch {}
    ended = true;
    for (const wake of waiters) wake();
  })();
  const until = async (test: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the stream");
      await new Promise<void>((resolve) => {
        waiters.add(resolve);
        setTimeout(resolve, 20);
      });
    }
  };
  await until(() => frames.some((frame) => frame.event === "handshake"));
  return {
    status: response.status,
    frames,
    until,
    get ended() {
      return ended;
    },
    handshake: () =>
      JSON.parse(frames.find((frame) => frame.event === "handshake")!.data) as {
        capabilities: string[];
      },
    cards: () =>
      frames
        .filter((frame) => frame.event === "ui")
        .map(
          (frame) => JSON.parse(frame.data) as { type: string; items?: { id: string }[] },
        )
        .filter((frame) => frame.type === "confirmations")
        .at(-1)?.items ?? [],
  };
}

async function openTab(server: FrameworkServer, token: string, clientId: string) {
  const stream = await openStream(server, { token, clientId });
  const presence = await post(
    server,
    "/_parlor/ui",
    {
      type: "presence",
      focused: true,
      visible: true,
      platform: "web",
      ops: [],
      canConfirm: true,
    },
    { token, clientId },
  );
  expect(presence.status).toBe(204);
  return stream;
}

describe("identity without an enforcing provider", () => {
  it("leaves every caller anonymous and keeps the declared source", async () => {
    const server = createServer({ actions });
    servers.push(server);
    const result = await json(
      await post(server, "/_parlor/actions/whoami", {}, { source: "ui" }),
    );
    expect(result).toEqual({
      status: 200,
      body: {
        data: { principal: { kind: "anonymous" }, scope: "default", source: "ui" },
        tags: [],
      },
    });
  });
});

describe("identity with an enforcing provider", () => {
  it("resolves the principal once per request and scopes to the user by default", async () => {
    const server = serve();
    const result = await json(
      await post(server, "/_parlor/actions/whoami", {}, { token: "alice" }),
    );
    expect(result.body).toMatchObject({
      data: {
        principal: { kind: "user", userId: "alice" },
        scope: "alice",
        source: "ui",
      },
    });
    expect(auth.calls).toBe(1);
  });

  it("refuses anonymous callers except on public actions", async () => {
    const server = serve();
    expect(await json(await post(server, "/_parlor/actions/whoami", {}))).toMatchObject({
      status: 401,
      body: { error: { code: "unauthenticated" } },
    });
    expect(await json(await post(server, "/_parlor/actions/ping", {}))).toEqual({
      status: 200,
      body: { data: { principal: "anonymous" }, tags: [] },
    });
  });

  it("answers an unknown credential with 401 rather than treating it as anonymous", async () => {
    const server = serve();
    const result = await json(
      await post(server, "/_parlor/actions/ping", {}, { token: "forged" }),
    );
    expect(result).toMatchObject({
      status: 401,
      body: { error: { code: "unauthenticated" } },
    });
  });

  it("ignores a forged source header: the credential decides", async () => {
    const server = serve();
    const asUser = await json(
      await post(
        server,
        "/_parlor/actions/whoami",
        {},
        { token: "alice", source: "mcp" },
      ),
    );
    expect(asUser.body).toMatchObject({ data: { source: "ui" } });
    const asAgent = await json(
      await post(
        server,
        "/_parlor/actions/whoami",
        {},
        { token: "alice-agent", source: "ui" },
      ),
    );
    expect(asAgent.body).toMatchObject({ data: { source: "mcp" } });
  });

  it("still asks before an agent's confirm action runs when it claims to be the UI", async () => {
    const server = serve();
    const result = await json(
      await post(
        server,
        "/_parlor/actions/deleteTask",
        { id: "t1" },
        { token: "alice-agent", source: "ui", clientId: "forged-tab" },
      ),
    );
    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "confirmation_unavailable" } },
    });
  });

  it("keeps hosts off app actions and browsers off MCP", async () => {
    const server = serve();
    expect(
      await json(
        await post(server, "/_parlor/actions/whoami", {}, { token: "alice-host" }),
      ),
    ).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    const mcp = await post(
      server,
      "/_parlor/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: "alice" },
    );
    expect(mcp.status).toBe(403);
  });

  it("challenges an anonymous MCP client so it can start OAuth", async () => {
    const server = serve();
    const response = await post(server, "/_parlor/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("lets no agent answer confirmations or post as a tab", async () => {
    const server = serve();
    const answer = await post(
      server,
      "/_parlor/ui",
      { type: "answer", id: "c1", approve: true },
      { token: "alice-agent", clientId: "tab" },
    );
    expect(answer.status).toBe(403);
    const anonymous = await post(
      server,
      "/_parlor/ui",
      { type: "answer", id: "c1", approve: true },
      { clientId: "tab" },
    );
    expect(anonymous.status).toBe(401);
  });

  it("gives a host's stream sync events but no channels", async () => {
    const server = serve();
    const host = await openStream(server, { token: "alice-host", clientId: "mac" });
    expect(host.status).toBe(200);
    expect(host.handshake().capabilities).toEqual([]);
    const tab = await openStream(server, { token: "alice", clientId: "tab" });
    expect(tab.handshake().capabilities).toEqual(["ui"]);
  });

  it("closes a stream when its credential is revoked", async () => {
    const server = serve();
    const tab = await openStream(server, { token: "alice", clientId: "tab" });
    auth.revoke("alice");
    await tab.until(() => tab.ended);
    expect(tab.ended).toBe(true);
  });
});

describe("two users sharing one organization scope", () => {
  it("shows an agent's confirmation only to its own user, and only that user answers it", async () => {
    const server = serve(() => "acme");
    const aliceTab = await openTab(server, "alice", "alice-tab");
    const bobTab = await openTab(server, "bob", "bob-tab");

    const call = post(
      server,
      "/_parlor/actions/deleteTask",
      { id: "t1" },
      { token: "alice-agent", clientId: "bob-tab" },
    );
    await aliceTab.until(() => aliceTab.cards().length === 1);
    const [card] = aliceTab.cards();
    expect(bobTab.cards()).toEqual([]);

    const fromBob = await post(
      server,
      "/_parlor/ui",
      { type: "answer", id: card!.id, approve: true },
      { token: "bob", clientId: "bob-tab" },
    );
    expect(fromBob.status).toBe(404);
    const posingAsAlice = await post(
      server,
      "/_parlor/ui",
      { type: "answer", id: card!.id, approve: true },
      { token: "bob", clientId: "alice-tab" },
    );
    expect(posingAsAlice.status).toBe(404);

    const fromAlice = await post(
      server,
      "/_parlor/ui",
      { type: "answer", id: card!.id, approve: true },
      { token: "alice", clientId: "alice-tab" },
    );
    expect(fromAlice.status).toBe(204);
    expect(await json(await call)).toEqual({
      status: 200,
      body: { data: { deleted: "t1" }, tags: [] },
    });
  });

  it("keeps a forged client id from attaching to another user's tab", async () => {
    const server = serve(() => "acme");
    await openTab(server, "alice", "alice-tab");
    const hijack = await post(
      server,
      "/_parlor/ui",
      {
        type: "presence",
        focused: true,
        visible: true,
        platform: "web",
        ops: [],
        canConfirm: true,
      },
      { token: "bob", clientId: "alice-tab" },
    );
    expect(hijack.status).toBe(404);
  });
});
