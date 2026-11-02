import { asId, defineAction, type KeyPrincipal } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { KeyVerifier } from "@parlor/server";
import { betterAuth } from "better-auth";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { parlorAuth } from "./better-auth.js";
import { rowsOf } from "./database.js";
import { betterAuthProvider } from "./provider.js";
import { createTestApp, ORIGIN, signUp, type TestApp } from "./testing/app.js";
import { callWith } from "./testing/computer.js";
import { credentialOf } from "./tokens.js";

const PREFIX = "tly_live_";
const KEY: KeyPrincipal = {
  kind: "key",
  keyId: asId("key", "k1"),
  scope: "org-a",
  name: 'API key "CI exporter"',
  claims: { role: "viewer" },
};
const keys: KeyVerifier = {
  prefix: PREFIX,
  verify: async (secret) => {
    if (secret === `${PREFIX}good`) return KEY;
    if (secret === `${PREFIX}unscoped`) return { ...KEY, scope: "" };
    if (secret === `${PREFIX}user`) {
      return { kind: "user", userId: "alice", sessionId: "s" } as unknown as KeyPrincipal;
    }
    return undefined;
  },
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

const JWS = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";

describe("credentialOf with an API key prefix", () => {
  it("takes a bearer token with the prefix as a key before any other shape", () => {
    expect(credentialOf(`Bearer ${PREFIX}abc`, PREFIX)).toEqual({
      kind: "key",
      secret: `${PREFIX}abc`,
    });
    expect(credentialOf(`Bearer ${PREFIX}${JWS}`, PREFIX)).toEqual({
      kind: "key",
      secret: `${PREFIX}${JWS}`,
    });
  });

  it("sorts every other token as before", () => {
    expect(credentialOf("Bearer sessiontoken", PREFIX)).toEqual({
      kind: "session",
      token: "sessiontoken",
    });
    expect(credentialOf(`Bearer ${PREFIX}abc`)).toEqual({
      kind: "session",
      token: `${PREFIX}abc`,
    });
    expect(() => credentialOf(`ParlorHost ${PREFIX}abc`, PREFIX)).toThrow(
      "The host assertion is malformed.",
    );
  });
});

describe("betterAuthProvider keys", () => {
  const options = parlorAuth({
    origin: ORIGIN,
    signInPage: "/sign-in",
    secret: "a-test-secret-that-is-long-enough-for-better-auth",
  });

  it.each(["tly", "tlylive", "TLY2", ""])(
    "refuses the prefix %j, which a session token could start with",
    (prefix) => {
      expect(() => betterAuthProvider({ options, keys: { ...keys, prefix } })).toThrow(
        /needs a character other than a letter or digit/,
      );
    },
  );

  it("accepts a prefix with a separator in it", () => {
    expect(() => betterAuthProvider({ options, keys })).not.toThrow();
    expect(() =>
      betterAuthProvider({
        instance: betterAuth(options) as never,
        keys: { ...keys, prefix: "sk-" },
      }),
    ).not.toThrow();
  });
});

describe("API keys through the server", () => {
  let handle: DatabaseHandle;
  let app: TestApp;

  beforeAll(async () => {
    handle = await createDatabase({ dataDir: "memory://" });
    app = createTestApp(handle, { actions, keys });
  }, 30_000);
  afterAll(async () => {
    await app.server.close();
    await handle.close();
  });

  it("turns a valid key into its principal, in its own scope", async () => {
    const answer = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `Bearer ${PREFIX}good`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body?.data).toEqual({ kind: "key", scope: "org-a", source: "http" });
  });

  it("never turns what verify answers into anything but a scoped key principal", async () => {
    for (const secret of ["user", "unscoped"]) {
      const answer = await callWith(
        app.server,
        "/_parlor/actions/whoami",
        `Bearer ${PREFIX}${secret}`,
      );
      expect(answer.status).toBe(500);
      expect(answer.body).toMatchObject({ error: { code: "internal" } });
    }
  });

  it("answers an unknown key with 401 everywhere and no OAuth challenge on MCP", async () => {
    const actionsAnswer = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `Bearer ${PREFIX}revoked`,
    );
    expect(actionsAnswer.status).toBe(401);
    expect(actionsAnswer.body).toMatchObject({ error: { code: "unauthenticated" } });

    const mcp = await callWith(app.server, "/_parlor/mcp", `Bearer ${PREFIX}revoked`);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toBeNull();

    const oauth = await callWith(app.server, "/_parlor/mcp", "Bearer not-a-session");
    expect(oauth.status).toBe(401);
    expect(oauth.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("keeps signed-in users working beside keys", async () => {
    const alice = await signUp(app.server, "Alice");
    const answer = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `Bearer ${alice.token}`,
    );
    expect(answer.body?.data).toMatchObject({ kind: "user", source: "ui" });
  });

  it("audits every key call with the key's id and name, whether it ran or was refused", async () => {
    await app.server.close();
    await handle.db.execute(sql`truncate parlor_auth_audit`);
    app = createTestApp(handle, { actions, keys });
    const ok = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `Bearer ${PREFIX}good`,
    );
    const refused = await callWith(
      app.server,
      "/_parlor/actions/deleteTask",
      `Bearer ${PREFIX}good`,
    );
    expect([ok.status, refused.status]).toEqual([200, 400]);
    const gated = await app.server.fetch(
      new Request(`${ORIGIN}/_parlor/actions/deleteTask`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${PREFIX}good`,
        },
        body: JSON.stringify({ id: "t1" }),
      }),
    );
    expect(gated.status).toBe(503);
    await app.server.close();

    const rows = rowsOf<Record<string, unknown>>(
      await handle.db.execute(
        sql`select actor_kind, user_id, key_id, key_name, action, source, scope, stage, outcome from parlor_auth_audit order by id`,
      ),
    );
    const row = {
      actor_kind: "key",
      user_id: null,
      key_id: "k1",
      key_name: 'API key "CI exporter"',
      source: "http",
      scope: "org-a",
    };
    expect(rows).toEqual([
      { ...row, action: "whoami", stage: "ran", outcome: "ok" },
      { ...row, action: "deleteTask", stage: "refused", outcome: "invalid_input" },
      {
        ...row,
        action: "deleteTask",
        stage: "refused",
        outcome: "confirmation_unavailable",
      },
    ]);
    expect(ran).toEqual([]);
    app = createTestApp(handle, { actions, keys });
  });

  it("finds a key's records by its index", async () => {
    const plan = rowsOf<{ indexname: string }>(
      await handle.db.execute(
        sql`select indexname from pg_indexes where tablename = 'parlor_auth_audit' and indexdef like '%(key_id, at)%'`,
      ),
    );
    expect(plan.map((index) => index.indexname)).toEqual(["parlor_auth_audit_by_key"]);
  });
});
