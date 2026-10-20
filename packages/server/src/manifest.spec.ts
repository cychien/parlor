import { ANONYMOUS, asId, type AuthenticatedPrincipal, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AuthFailure, type AuthProvider } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";

const alice = asId("user", "alice");
const PRINCIPALS: Record<string, AuthenticatedPrincipal> = {
  user: { kind: "user", userId: alice, sessionId: "s1" },
  agent: {
    kind: "agent",
    userId: alice,
    grantId: asId("grant", "oauth:alice:claude"),
    agent: { name: "Claude Code", verified: true },
  },
  host: {
    kind: "host",
    userId: asId("user", "bob"),
    grantId: asId("grant", "host:h1"),
    hostId: asId("host", "h1"),
  },
};

const enforcing: AuthProvider = {
  name: "test-auth",
  enforcing: true,
  setup: () => ({}),
  authenticate: async (request) => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token === "stale") throw new AuthFailure("revoked", "Signed out.");
    return (token && PRINCIPALS[token]) || ANONYMOUS;
  },
  challenge: () => new Response(null, { status: 401 }),
  revoked: () => new AbortController().signal,
};

const actions = createRegistry({
  listTasks: defineAction({
    description: "List tasks.",
    input: z.object({}),
    run: () => [],
  }),
});

const servers: FrameworkServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function manifest(token?: string) {
  vi.stubEnv("PARLOR_APP_NAME", "Hello");
  const server = createServer({ actions, auth: enforcing });
  servers.push(server);
  const response = await server.fetch(
    new Request("http://app.test/_parlor/manifest", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("the manifest under an enforcing provider", () => {
  it("tells anyone, signed in or not, only the app's name and protocol", async () => {
    for (const token of [undefined, "host"]) {
      expect(await manifest(token)).toEqual({
        status: 200,
        body: { protocol: 1, app: { name: "Hello" } },
      });
    }
  });

  it("lists the actions to users and agents as before", async () => {
    for (const token of ["user", "agent"]) {
      const { status, body } = await manifest(token);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        protocol: 1,
        app: { name: "Hello" },
        actions: [{ name: "listTasks" }],
      });
    }
  });

  it("still refuses a credential that fails", async () => {
    expect((await manifest("stale")).status).toBe(401);
  });
});
