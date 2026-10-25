import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { asId, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { callWith, Computer, HELLO, pair } from "./testing/computer.js";
import { probePlugin } from "./testing/probe.js";

let database: DatabaseHandle;
let app: TestApp;
const clients: Client[] = [];

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute(sql`select 1`);
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(() => {
  app = createTestApp(database, { plugins: [probePlugin] });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await app.server.close();
});

async function pairedComputer() {
  const alice = await signUpAs(app.server, "Alice");
  const computer = await pair(app.server, alice);
  return { alice, computer };
}

const hello = (computer: Computer, overrides: Parameters<Computer["assertion"]>[0]) =>
  computer
    .assertion(overrides)
    .then((jws) => callWith(app.server, HELLO, `ParlorHost ${jws}`));

const helloUrl = `${ORIGIN}${HELLO}`;

describe("host assertions", () => {
  it("admits a fresh assertion as the host principal", async () => {
    const { computer } = await pairedComputer();
    const response = await hello(computer, { url: helloUrl });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        accepted: true,
        protocol: 1,
        hostId: computer.grant!.grant.hostId,
        grantId: computer.grant!.grant.id,
      },
      tags: [],
    });
  });

  it("ignores the query string, as the assertion is bound to the URL without it", async () => {
    const { computer } = await pairedComputer();
    const jws = await computer.assertion({ url: helloUrl });
    const response = await callWith(app.server, `${HELLO}?cursor=3`, `ParlorHost ${jws}`);
    expect(response.status).toBe(200);
  });

  it("refuses a replayed assertion", async () => {
    const { computer } = await pairedComputer();
    const jws = await computer.assertion({ url: helloUrl });
    expect((await callWith(app.server, HELLO, `ParlorHost ${jws}`)).status).toBe(200);
    expect((await callWith(app.server, HELLO, `ParlorHost ${jws}`)).status).toBe(401);
  });

  it("refuses an assertion made for another URL or method", async () => {
    const { computer } = await pairedComputer();
    const forHello = await computer.assertion({ url: helloUrl });
    const elsewhere = await callWith(
      app.server,
      "/_parlor/auth/actions/hosts",
      `ParlorHost ${forHello}`,
    );
    expect(elsewhere.status).toBe(401);
    const otherHost = await computer.assertion({
      url: `http://other.example${HELLO}`,
    });
    expect((await callWith(app.server, HELLO, `ParlorHost ${otherHost}`)).status).toBe(
      401,
    );
    const getAssertion = await computer.assertion({ url: helloUrl, method: "GET" });
    expect((await callWith(app.server, HELLO, `ParlorHost ${getAssertion}`)).status).toBe(
      401,
    );
  });

  it("refuses an assertion issued 61 s ago and admits one issued 58 s ago", async () => {
    const { computer } = await pairedComputer();
    const now = Math.floor(Date.now() / 1000);
    expect((await hello(computer, { url: helloUrl, iat: now - 61 })).status).toBe(401);
    expect((await hello(computer, { url: helloUrl, iat: now - 58 })).status).toBe(200);
  });

  it("refuses an assertion issued in the future", async () => {
    const { computer } = await pairedComputer();
    const now = Math.floor(Date.now() / 1000);
    expect((await hello(computer, { url: helloUrl, iat: now + 30 })).status).toBe(401);
  });

  it("refuses an unknown grant, another key, and the wrong audience", async () => {
    const { computer } = await pairedComputer();
    expect((await hello(computer, { url: helloUrl, gid: "host:nobody" })).status).toBe(
      401,
    );
    expect((await hello(computer, { url: helloUrl, aud: "parlor:mcp" })).status).toBe(
      401,
    );
    const stranger = new Computer();
    stranger.grant = computer.grant;
    expect((await hello(stranger, { url: helloUrl })).status).toBe(401);
  });

  it("is not a bearer token, and a host cannot use the signed-in surfaces", async () => {
    const { computer } = await pairedComputer();
    const jws = await computer.assertion({ url: helloUrl });
    expect((await callWith(app.server, HELLO, `Bearer ${jws}`)).status).toBe(401);
    const whoami = await computer.assertion({ url: `${ORIGIN}/_parlor/actions/whoami` });
    const refused = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `ParlorHost ${whoami}`,
    );
    expect(refused.status).toBe(403);
    expect(refused.body?.error.code).toBe("forbidden");
  });

  it("answers 401 with a challenge when a host assertion reaches MCP", async () => {
    const { computer } = await pairedComputer();
    const jws = await computer.assertion({ url: `${ORIGIN}/_parlor/mcp` });
    const response = await callWith(app.server, "/_parlor/mcp", `ParlorHost ${jws}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/_parlor/mcp", scope="mcp"`,
    );
  });
});

describe("turn tokens", () => {
  async function mint() {
    const { alice, computer } = await pairedComputer();
    const { grant, account } = computer.grant!;
    const principal: HostPrincipal = {
      kind: "host",
      userId: account.userId,
      grantId: grant.id,
      hostId: grant.hostId,
    };
    const delegation = await app.provider.delegate!(principal, {
      threadId: asId("thread", "thr-1"),
      turnId: asId("turn", "trn-1"),
      clientId: "tab-1",
      agent: "Claude Code",
      ttlMs: 120_000,
    });
    return { alice, computer, delegation, principal };
  }

  it("is refused where only a host may go", async () => {
    const { delegation } = await mint();
    const response = await callWith(app.server, HELLO, `Bearer ${delegation.token}`);
    expect(response.status).toBe(403);
    expect(response.body?.error.code).toBe("forbidden");
  });

  it("is not a host assertion", async () => {
    const { delegation } = await mint();
    const response = await callWith(app.server, HELLO, `ParlorHost ${delegation.token}`);
    expect(response.status).toBe(401);
  });

  it("calls MCP tools as the user's agent bound to its turn", async () => {
    const { delegation, principal } = await mint();
    const client = new Client({ name: "proxy", version: "0.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/_parlor/mcp`), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${delegation.token}`);
          return app.server.fetch(new Request(input, { ...init, headers }));
        },
      }),
    );
    const result = await client.callTool({ name: "whoami", arguments: {} });
    const seen = result.structuredContent as { principal: unknown; source: string };
    expect(seen.source).toBe("agent");
    expect(seen.principal).toEqual({
      kind: "agent",
      userId: principal.userId,
      grantId: principal.grantId,
      agent: { name: "Claude Code", verified: true },
      turn: {
        threadId: "thr-1",
        turnId: "trn-1",
        hostId: principal.hostId,
        clientId: "tab-1",
      },
    });
  });
});

describe("agent tokens outside any turn", () => {
  async function mint() {
    const { alice, computer } = await pairedComputer();
    const { grant, account } = computer.grant!;
    const principal: HostPrincipal = {
      kind: "host",
      userId: account.userId,
      grantId: grant.id,
      hostId: grant.hostId,
    };
    const delegation = await app.provider.delegateAgent!(principal, {
      agent: "Claude Code on Alice's MacBook",
      ttlMs: 120_000,
    });
    return { alice, computer, delegation, principal };
  }

  it("calls MCP tools as an external agent of the user, bound to no turn", async () => {
    const { delegation, principal } = await mint();
    const client = new Client({ name: "proxy", version: "0.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/_parlor/mcp`), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${delegation.token}`);
          return app.server.fetch(new Request(input, { ...init, headers }));
        },
      }),
    );
    const result = await client.callTool({ name: "whoami", arguments: {} });
    const seen = result.structuredContent as { principal: unknown; source: string };
    expect(seen.source).toBe("mcp");
    expect(seen.principal).toEqual({
      kind: "agent",
      userId: principal.userId,
      grantId: principal.grantId,
      agent: { name: "Claude Code on Alice's MacBook", verified: true },
    });
  });

  it("is neither a host assertion nor allowed where only a host may go", async () => {
    const { delegation } = await mint();
    expect(
      (await callWith(app.server, HELLO, `ParlorHost ${delegation.token}`)).status,
    ).toBe(401);
    const response = await callWith(app.server, HELLO, `Bearer ${delegation.token}`);
    expect(response.status).toBe(403);
  });

  it("dies with the computer's grant", async () => {
    const { alice, delegation, principal } = await mint();
    await alice.account("revokeHost", { hostId: principal.hostId });
    const mcp = await callWith(app.server, "/_parlor/mcp", `Bearer ${delegation.token}`);
    expect(mcp.status).toBe(401);
  });
});
