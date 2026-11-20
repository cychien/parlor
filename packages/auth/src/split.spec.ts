import { createHash } from "node:crypto";

import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { createServer } from "@parlor/server";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { parlorAuth } from "./better-auth.js";
import { betterAuthProvider } from "./provider.js";
import { Browser, ORIGIN, PASSWORD } from "./testing/app.js";

const digest = (password: string) => createHash("sha256").update(password).digest("hex");

const actions = createRegistry({
  whoami: defineAction({
    description: "Who is calling.",
    input: z.object({}),
    run: (_input, ctx) => ({ kind: ctx.principal.kind }),
  }),
});

let database: DatabaseHandle;
beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);
afterAll(() => database.close());

describe("auth in a server split per account", () => {
  it("signs in through every server built from options the app made once", async () => {
    const authOptions = parlorAuth({
      origin: ORIGIN,
      signInPage: "/sign-in",
      appName: "Hello",
      secret: "a-test-secret-that-is-long-enough-for-better-auth",
      emailAndPassword: {
        enabled: true,
        password: {
          hash: (password) => Promise.resolve(digest(password)),
          verify: ({ hash, password }) => Promise.resolve(digest(password) === hash),
        },
      },
    });
    const store = memoryAdapter(
      Object.fromEntries(
        Object.values(getAuthTables(authOptions)).map((table) => [table.modelName, []]),
      ),
    );
    const server = createServer(() => ({
      actions,
      database: { ...database, close: undefined },
      auth: betterAuthProvider({ options: { ...authOptions, database: store } }),
    }));
    const split = server.split!();
    const servers = [split.edge, split.account("ua"), split.account("ub")];

    const signUp = await new Browser(servers[0]!).fetch("/_parlor/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: PASSWORD, name: "Ada" }),
    });
    expect(signUp.status).toBe(200);

    for (const one of servers) {
      const browser = new Browser(one);
      const signIn = await browser.fetch("/_parlor/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }),
      });
      expect(signIn.status).toBe(200);
      const whoami = await browser.fetch("/_parlor/actions/whoami", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(await whoami.json()).toMatchObject({ data: { kind: "user" } });
    }
  });
});
