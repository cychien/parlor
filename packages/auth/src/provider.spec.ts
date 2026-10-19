import { createHash, randomBytes } from "node:crypto";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { FrameworkServer } from "@parlor/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  Browser,
  createTestApp,
  ORIGIN,
  signIn as signInAs,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";

const REDIRECT = "http://127.0.0.1:43123/callback";

let database: DatabaseHandle;
let app: TestApp;
let server: FrameworkServer;
const clients: Client[] = [];
const streams: AbortController[] = [];

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(() => {
  app = createTestApp(database);
  server = app.server;
});

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server.close();
});

const signUp = (name: string) => signUpAs(server, name);
const signIn = (name: string) => signInAs(server, name);

async function whoami(headers: HeadersInit = {}, browser?: Browser) {
  const response = browser
    ? await browser.post("/_parlor/actions/whoami", {}, headers)
    : await server.fetch(
        new Request(`${ORIGIN}/_parlor/actions/whoami`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...Object.fromEntries(new Headers(headers)),
          },
          body: "{}",
        }),
      );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

const account = (browser: Browser, action: string, input: unknown = {}) =>
  browser.account(action, input);

function openStream(headers: HeadersInit) {
  const controller = new AbortController();
  streams.push(controller);
  const closed = (async () => {
    const response = await server.fetch(
      new Request(`${ORIGIN}/_parlor/sync/stream?since=`, {
        headers: {
          accept: "text/event-stream",
          ...Object.fromEntries(new Headers(headers)),
        },
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) return Date.now();
    }
  })();
  return { closed };
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms),
    ),
  ]);

describe("sessions", () => {
  it("resolves a cookie and a bearer session to the same user", async () => {
    const alice = await signUp("Alice");
    const byCookie = await whoami({}, alice);
    expect(byCookie.status).toBe(200);
    expect(byCookie.body.data.principal).toMatchObject({ kind: "user" });
    const byBearer = await whoami({ authorization: `Bearer ${alice.token}` });
    expect(byBearer.body.data.principal.userId).toBe(byCookie.body.data.principal.userId);
    expect(byBearer.body.data.scope).toBe(byCookie.body.data.principal.userId);
    expect(byBearer.body.data.source).toBe("ui");
  });

  it("refuses anonymous callers except for public actions", async () => {
    expect((await whoami()).status).toBe(401);
    const ping = await server.fetch(
      new Request(`${ORIGIN}/_parlor/actions/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(ping.status).toBe(200);
  });

  it("refuses a bearer token that is no session", async () => {
    const result = await whoami({ authorization: "Bearer not-a-session" });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("unauthenticated");
  });

  it("keeps users apart: each one gets their own scope", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const a = await whoami({}, alice);
    const b = await whoami({}, bob);
    expect(a.body.data.scope).not.toBe(b.body.data.scope);
  });

  it("lists sessions and revokes another one, closing its stream", async () => {
    const laptop = await signUp("Alice");
    const phone = await signIn("Alice");
    const listed = await account(laptop, "sessions");
    expect(listed.body.data).toHaveLength(2);
    const other = listed.body.data.find(
      (session: { current: boolean }) => !session.current,
    );

    const stream = openStream({ authorization: `Bearer ${phone.token}` });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const revokedAt = Date.now();
    expect((await account(laptop, "revokeSession", { id: other.id })).status).toBe(200);
    const closedAt = await within(stream.closed, 5000);
    expect(closedAt - revokedAt).toBeLessThan(5000);
    expect((await whoami({ authorization: `Bearer ${phone.token}` })).status).toBe(401);
    expect((await whoami({}, laptop)).status).toBe(200);
  });

  it("closes the stream of a session that signs out", async () => {
    const alice = await signUp("Alice");
    const stream = openStream({ authorization: `Bearer ${alice.token}` });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await alice.post(
      "/_parlor/auth/sign-out",
      {},
      { authorization: `Bearer ${alice.token}` },
    );
    await within(stream.closed, 5000);
  });

  it("refuses another user's session id", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const [aliceSession] = (await account(alice, "sessions")).body.data;
    const result = await account(bob, "revokeSession", { id: aliceSession.id });
    expect(result.status).toBe(404);
    expect((await whoami({}, alice)).status).toBe(200);
  });
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(
  name: string,
  owner: Browser,
  { trusted = false } = {},
): Promise<string> {
  const api = app.instance.api as unknown as {
    adminCreateOAuthClient(input: {
      body: Record<string, unknown>;
      headers: Headers;
    }): Promise<{ client_id: string }>;
  };
  const client = await api.adminCreateOAuthClient({
    headers: new Headers({ authorization: `Bearer ${owner.token}` }),
    body: {
      client_name: name,
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      scope: "mcp offline_access",
      ...(trusted ? { skip_consent: true } : {}),
    },
  });
  return client.client_id;
}

async function authorize(browser: Browser, clientId: string) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "mcp offline_access",
    resource: `${ORIGIN}/_parlor/mcp`,
  });
  const start = await browser.fetch(`/_parlor/auth/oauth2/authorize?${query}`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  return { start, verifier };
}

async function connectMcp(clientId: string, alice: Browser) {
  const { start, verifier } = await authorize(alice, clientId);
  expect(start.status).toBe(302);
  const consentUrl = new URL(start.headers.get("location")!, ORIGIN);
  expect(consentUrl.pathname).toBe("/_parlor/auth/consent");

  const page = await alice.fetch(consentUrl.pathname + consentUrl.search);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Allow Test Agent to use Hello?");
  expect(html).toContain("alice@example.com");
  expect(html).toContain("its publisher is not verified");
  expect(html).toContain("127.0.0.1:43123");
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
  expect(page.headers.get("content-security-policy")).toContain(
    "form-action 'self' http://127.0.0.1:43123",
  );

  const answer = await alice.fetch("/_parlor/auth/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      accept: "true",
      oauth_query: consentUrl.search.slice(1),
    }),
  });
  expect(answer.status).toBe(303);
  const callback = new URL(answer.headers.get("location")!);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  expect(callback.searchParams.get("state")).toBe("xyz");
  expect(callback.searchParams.get("iss")).toBe(`${ORIGIN}/_parlor/auth`);

  return exchange(clientId, callback.searchParams.get("code")!, verifier);
}

async function exchange(clientId: string, code: string, verifier: string) {
  const token = await server.fetch(
    new Request(`${ORIGIN}/_parlor/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/_parlor/mcp`,
      }),
    }),
  );
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token?: string };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/_parlor/mcp`), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${accessToken}`);
        return server.fetch(new Request(input, { ...init, headers }));
      },
    }),
  );
  return client;
}

describe("MCP authorization", () => {
  it("publishes discovery documents at the origin root", async () => {
    const resource = await server.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/_parlor/mcp`),
    );
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: `${ORIGIN}/_parlor/mcp`,
      authorization_servers: [`${ORIGIN}/_parlor/auth`],
      scopes_supported: expect.arrayContaining(["mcp"]),
    });
    const issuer = await server.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server/_parlor/auth`),
    );
    expect(issuer.status).toBe(200);
    expect(await issuer.json()).toMatchObject({
      issuer: `${ORIGIN}/_parlor/auth`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      scopes_supported: expect.arrayContaining(["mcp", "offline_access"]),
    });
  });

  it("answers an anonymous MCP request with an RFC 9728 challenge", async () => {
    const response = await server.fetch(
      new Request(`${ORIGIN}/_parlor/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/_parlor/mcp", scope="mcp"`,
    );
  });

  it("sends a signed-out user to the app's sign-in page first", async () => {
    const clientId = await registerClient("Test Agent", await signUp("Admin"));
    const { start } = await authorize(new Browser(server), clientId);
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location")!, ORIGIN).pathname).toBe("/sign-in");
  });

  it("acts as the user who consented, until the user revokes the agent", async () => {
    const alice = await signUp("Alice");
    const aliceId = (await whoami({}, alice)).body.data.principal.userId;
    const clientId = await registerClient("Test Agent", alice);
    const tokens = await connectMcp(clientId, alice);
    expect(tokens.refresh_token).toBeTruthy();

    const client = await mcpClient(tokens.access_token);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      principal: {
        kind: "agent",
        userId: aliceId,
        agent: { name: "Test Agent", verified: false },
      },
      scope: aliceId,
      source: "mcp",
    });
    expect(
      (await whoami({ authorization: `Bearer ${tokens.access_token}` })).body.data.source,
    ).toBe("mcp");

    const agents = await account(alice, "agents");
    expect(agents.body.data).toEqual([
      expect.objectContaining({ clientId, name: "Test Agent" }),
    ]);
    expect((await account(alice, "revokeAgent", { clientId })).status).toBe(200);
    expect(
      (await whoami({ authorization: `Bearer ${tokens.access_token}` })).status,
    ).toBe(401);
    expect((await account(alice, "agents")).body.data).toEqual([]);

    const refresh = await server.fetch(
      new Request(`${ORIGIN}/_parlor/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token!,
          client_id: clientId,
          resource: `${ORIGIN}/_parlor/mcp`,
        }),
      }),
    );
    expect(refresh.status).toBe(400);
  });

  it("issues tokens again after a revoked agent is authorized anew", async () => {
    const alice = await signUp("Alice");
    const clientId = await registerClient("Test Agent", alice);
    const first = await connectMcp(clientId, alice);
    await account(alice, "revokeAgent", { clientId });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await connectMcp(clientId, alice);
    expect(
      (await whoami({ authorization: `Bearer ${second.access_token}` })).status,
    ).toBe(200);
    expect((await whoami({ authorization: `Bearer ${first.access_token}` })).status).toBe(
      401,
    );
  });

  it("lists and revokes a trusted agent that never asked for consent", async () => {
    const alice = await signUp("Alice");
    const clientId = await registerClient("Trusted Agent", alice, { trusted: true });
    const { start, verifier } = await authorize(alice, clientId);
    expect(start.status).toBe(302);
    const callback = new URL(start.headers.get("location")!);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    const tokens = await exchange(clientId, callback.searchParams.get("code")!, verifier);

    expect((await account(alice, "agents")).body.data).toEqual([
      expect.objectContaining({ clientId, name: "Trusted Agent" }),
    ]);
    await account(alice, "revokeAgent", { clientId });
    expect(
      (await whoami({ authorization: `Bearer ${tokens.access_token}` })).status,
    ).toBe(401);
    expect((await account(alice, "agents")).body.data).toEqual([]);
  });

  it("refuses a consent answer posted from another origin", async () => {
    const alice = await signUp("Alice");
    const response = await alice.fetch("/_parlor/auth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.test",
      },
      body: new URLSearchParams({ accept: "true", oauth_query: "a=b" }),
    });
    expect(response.status).toBe(403);
  });

  it("keeps the account actions away from agents", async () => {
    const alice = await signUp("Alice");
    const clientId = await registerClient("Test Agent", alice);
    const tokens = await connectMcp(clientId, alice);
    const response = await server.fetch(
      new Request(`${ORIGIN}/_parlor/auth/actions/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });
});
