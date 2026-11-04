import {
  ANONYMOUS,
  asId,
  defineAction,
  type Principal,
  type TurnBinding,
  userOf,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuthProvider } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";
import type { ScopeResolver } from "./scope.js";

const alice = asId("user", "alice");
const turn = (scope?: string): TurnBinding => ({
  threadId: asId("thread", "t1"),
  turnId: asId("turn", "u1"),
  hostId: asId("host", "mac"),
  clientId: "tab",
  ...(scope === undefined ? {} : { scope }),
});
const agent = (binding: TurnBinding): Principal => ({
  kind: "agent",
  userId: alice,
  grantId: asId("grant", "g-mac"),
  agent: { name: "Claude Code", verified: true },
  turn: binding,
});
const TOKENS: Record<string, Principal> = {
  alice: { kind: "user", userId: alice, sessionId: "s-alice" },
  "acme-turn": agent(turn("org:acme")),
  "unscoped-turn": agent(turn()),
};

const provider: AuthProvider = {
  name: "scope-auth",
  setup: () => ({}),
  enforcing: true,
  authenticate(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    return Promise.resolve((token && TOKENS[token]) || ANONYMOUS);
  },
  challenge: () => new Response(null, { status: 401 }),
  revoked: () => new AbortController().signal,
};

/** Picks the org from a header, as an app whose users belong to several orgs does. */
const byHeader: ScopeResolver = (request, principal) => {
  const org = request.headers.get("x-org");
  return org ? `org:${org}` : `user:${userOf(principal) ?? "nobody"}`;
};

const honoringTurns: ScopeResolver = (request, principal) =>
  (principal.kind === "agent" ? principal.turn?.scope : undefined) ??
  byHeader(request, principal);

const actions = createRegistry({
  whereAmI: defineAction({
    description: "The scope the call runs in.",
    input: z.object({}),
    run: (_input, ctx) => ({ scope: ctx.scope }),
  }),
  touchComputer: defineAction({
    description: "Change something of the person's, not the org's.",
    input: z.object({}),
    writes: ["computers"],
    notifies: "account",
    run: () => ({ id: "mac" }),
  }),
});

let database: DatabaseHandle;
let server: FrameworkServer | undefined;

beforeEach(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterEach(async () => {
  await (server ?? database).close();
  server = undefined;
});

const serve = (scope: ScopeResolver) => {
  server = createServer({ actions, database, auth: provider, scope });
};

async function call(token: string, name: string, org?: string) {
  const response = await server!.fetch(
    new Request(`http://app.test/_parlor/actions/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(org ? { "x-org": org } : {}),
      },
      body: "{}",
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function eventsFor(org: string): Promise<unknown[]> {
  const response = await server!.fetch(
    new Request("http://app.test/_parlor/sync?since=0", {
      headers: { authorization: "Bearer alice", "x-org": org },
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { events: unknown[] }).events;
}

describe("a turn's scope", { timeout: 30_000 }, () => {
  it("is where its agent acts when the app's resolver honors it", async () => {
    serve(honoringTurns);
    expect(await call("acme-turn", "whereAmI")).toMatchObject({
      status: 200,
      body: { data: { scope: "org:acme" } },
    });
  });

  it("is the only scope its agent acts in, whatever the resolver answers", async () => {
    serve(byHeader);
    for (const org of [undefined, "globex"]) {
      const refused = await call("acme-turn", "whereAmI", org);
      expect(refused.status, org).toBe(403);
      expect(refused.body, org).toMatchObject({
        error: {
          code: "forbidden",
          message: "This turn acts only in its conversation's scope.",
        },
      });
    }
    expect((await call("acme-turn", "whereAmI", "acme")).status).toBe(200);
  });

  it("leaves a token minted without one to the resolver", async () => {
    serve(byHeader);
    expect(await call("unscoped-turn", "whereAmI", "globex")).toMatchObject({
      status: 200,
      body: { data: { scope: "org:globex" } },
    });
  });
});

describe("a write that notifies the account", { timeout: 30_000 }, () => {
  it("reaches the user's tabs in every scope, and nobody else's", async () => {
    serve(byHeader);
    expect((await call("alice", "touchComputer", "acme")).status).toBe(200);
    for (const org of ["acme", "globex"]) {
      expect(await eventsFor(org), org).toEqual([
        expect.objectContaining({ tags: [["computers", "mac"]] }),
      ]);
    }
    const rows = (await database.db.execute(
      "select scope from sync_events" as never,
    )) as unknown as { rows: { scope: string }[] };
    expect(rows.rows.map((row) => row.scope)).toEqual(["\u001falice"]);
  });
});
