import { asId, DEV_USER_ID, defineAction, type HostPrincipal } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { serve } from "srvx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AuthFailure } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";
import { DEV_AUTH_PLUGIN, DEV_HOST_PATH, devAuth } from "./dev-auth.js";
import { pluginRoute, type ServerPlugin } from "./plugin.js";

const ORIGIN = "http://localhost:3300";
const HOST_URL = `${ORIGIN}/_parlor/${DEV_AUTH_PLUGIN}${DEV_HOST_PATH}`;

const actions = createRegistry({
  ping: defineAction({
    description: "Answer with the caller's source.",
    input: z.object({}),
    run: (_input, ctx) => ({ source: ctx.source, scope: ctx.scope }),
  }),
});

const whoami: ServerPlugin = {
  name: "whoami",
  setup: () => ({
    routes: [
      pluginRoute({
        method: "GET",
        path: "/me",
        access: ["anonymous", "host", "agent", "user"],
        handle: async (_request, caller) =>
          Response.json({
            principal: caller.principal,
            scope: caller.scope,
            audience: caller.audience,
          }),
      }),
    ],
  }),
};

const servers: FrameworkServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function devServer(options: { readonly withAuth?: boolean } = {}): FrameworkServer {
  const server = createServer({
    actions,
    plugins: [whoami],
    ...(options.withAuth ? { auth: devAuth() } : {}),
  });
  servers.push(server);
  return server;
}

function from(ip: string | undefined, init: RequestInit = {}): Request {
  const request = new Request(HOST_URL, { method: "POST", ...init });
  if (ip !== undefined) Object.defineProperty(request, "ip", { value: ip });
  return request;
}

async function hostToken(server: FrameworkServer): Promise<string> {
  const response = await server.fetch(from("127.0.0.1"));
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function me(server: FrameworkServer, authorization?: string) {
  const response = await server.fetch(
    new Request(`${ORIGIN}/_parlor/whoami/me`, {
      headers: authorization ? { authorization } : {},
    }),
  );
  return { status: response.status, body: (await response.json()) as never };
}

describe("devAuth under parlor dev", () => {
  it("is installed only when the app sets no auth and PARLOR_DEV is 1", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    expect((await devServer().fetch(from("127.0.0.1"))).status).toBe(200);

    vi.stubEnv("PARLOR_DEV", "");
    expect((await devServer().fetch(from("127.0.0.1"))).status).toBe(404);
  });

  it("mints the dev host token for a loopback caller only, and never through a page", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    const server = devServer();
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect((await server.fetch(from(ip))).status).toBe(200);
    }
    for (const ip of ["192.168.1.20", "10.0.0.2", "::ffff:192.168.1.20", undefined]) {
      expect((await server.fetch(from(ip))).status).toBe(403);
    }
    const withOrigin = await server.fetch(
      from("127.0.0.1", { headers: { origin: "http://localhost:5300" } }),
    );
    expect(withOrigin.status).toBe(403);
    const nullOrigin = await server.fetch(
      from("127.0.0.1", { headers: { origin: "null" } }),
    );
    expect(nullOrigin.status).toBe(403);
  });

  it("refuses a request from another machine over a real socket", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    const server = devServer();
    const listener = serve({
      fetch: (request) => server.fetch(request),
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
    });
    await listener.ready();
    try {
      const url = new URL(listener.url!);
      const loopback = await fetch(`${url.origin}/_parlor/dev-auth/host`, {
        method: "POST",
      });
      expect(loopback.status).toBe(200);
      const fromPage = await fetch(`${url.origin}/_parlor/dev-auth/host`, {
        method: "POST",
        headers: { origin: url.origin },
      });
      expect(fromPage.status).toBe(403);
    } finally {
      await listener.close(true);
    }
  });

  it("makes the dev host a host principal of the dev user, in the browser's scope and audience", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    const server = devServer();
    const host = await me(server, `ParlorHost ${await hostToken(server)}`);
    expect(host.status).toBe(200);
    expect(host.body).toMatchObject({
      principal: { kind: "host", userId: DEV_USER_ID, grantId: "dev", hostId: "dev" },
      scope: "default",
      audience: "default",
    });
    const browser = await me(server);
    expect(browser.body).toMatchObject({
      principal: { kind: "anonymous" },
      scope: "default",
      audience: "default",
    });
  });

  it("keeps the browser and external MCP clients anonymous with a header-declared source", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    const server = devServer();
    const response = await server.fetch(
      new Request(`${ORIGIN}/_parlor/actions/ping`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-parlor-source": "ui",
          authorization: "Bearer some-external-token",
        },
        body: "{}",
      }),
    );
    expect(await response.json()).toMatchObject({
      data: { source: "ui", scope: "default" },
    });
  });

  it("answers a stale dev host token with 401, so the dev host fetches a new one", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    const before = devServer();
    const stale = await hostToken(before);
    const after = devServer();
    expect((await me(after, `ParlorHost ${stale}`)).status).toBe(401);
    expect((await me(after, `ParlorHost ${stale.slice(0, -2)}xx`)).status).toBe(401);
  });

  it("is chosen over nothing but never over the app's own provider", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    const own = devAuth();
    const server = createServer({ actions, auth: own, plugins: [whoami] });
    servers.push(server);
    expect(own.name).toBe(DEV_AUTH_PLUGIN);
    expect(own.enforcing).toBe(false);
  });
});

describe("devAuth turn tokens", () => {
  const host: HostPrincipal = {
    kind: "host",
    userId: DEV_USER_ID,
    grantId: asId("grant", "dev"),
    hostId: asId("host", "dev"),
  };
  const turn = {
    threadId: asId("thread", "t1"),
    turnId: asId("turn", "u1"),
    clientId: "tab-1",
    agent: "Claude Code",
    ttlMs: 60_000,
  };
  const bearer = (token: string) =>
    new Request(`${ORIGIN}/_parlor/mcp`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it("binds an agent principal to the turn and the tab its prompt came from", async () => {
    const auth = devAuth();
    const { token, expiresAt } = await auth.delegate!(host, turn);
    expect(expiresAt).toBeGreaterThan(Date.now() + 55_000);
    expect(await auth.authenticate(bearer(token))).toEqual({
      kind: "agent",
      userId: DEV_USER_ID,
      grantId: "dev",
      agent: { name: "Claude Code", verified: true },
      turn: { threadId: "t1", turnId: "u1", hostId: "dev", clientId: "tab-1" },
    });
  });

  it("is a compact JWS for the MCP audience", async () => {
    const { token } = await devAuth().delegate!(host, turn);
    const [, payload] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      aud: "parlor:mcp",
    });
  });

  it("refuses a token another process minted, a tampered one and an expired one", async () => {
    const auth = devAuth();
    const other = await devAuth().delegate!(host, turn);
    await expect(auth.authenticate(bearer(other.token))).rejects.toBeInstanceOf(
      AuthFailure,
    );
    const own = await auth.delegate!(host, turn);
    const [header, payload, mac] = own.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, cid: "tab-2" })).toString(
      "base64url",
    );
    await expect(
      auth.authenticate(bearer(`${header}.${forged}.${mac}`)),
    ).rejects.toBeInstanceOf(AuthFailure);
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    try {
      await expect(auth.authenticate(bearer(own.token))).rejects.toMatchObject({
        reason: "expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never revokes and knows no devices", async () => {
    const auth = devAuth();
    expect(auth.revoked(host).aborted).toBe(false);
    expect(auth.device).toBeUndefined();
    expect(auth.hostActive).toBeUndefined();
  });
});
