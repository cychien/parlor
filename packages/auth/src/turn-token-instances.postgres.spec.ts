import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chat } from "@parlor/chat/server";
import { createFakeHost } from "@parlor/chat/testing";
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { type Database, rowsOf } from "./database.js";
import {
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { type Computer, pair } from "./testing/computer.js";
import {
  createScratchDatabase,
  postgresUrl,
  type ScratchDatabase,
} from "./testing/postgres.js";

const REFUSAL_BOUND_MS = 5000;
const TITLES = ["Buy milk", "Write report", "Call Amy"];

if (!postgresUrl) {
  console.info(
    "[parlor] multi-instance turn token specs skipped: set PARLOR_TEST_DATABASE_URL to run them",
  );
}

const tasks = createRegistry({
  listTasks: defineAction({
    description: "The caller's tasks.",
    input: z.object({}),
    reads: ["tasks"],
    run: async (_input, ctx) =>
      rowsOf<{ id: string; title: string }>(
        await (ctx.db as Database).execute(
          sql`select id, title from tasks where scope = ${ctx.scope} order by created_at`,
        ),
      ),
  }),
});

let scratch: ScratchDatabase;
const handles: DatabaseHandle[] = [];
const apps: TestApp[] = [];
const clients: Client[] = [];

const startedAt = performance.now();
const calls: {
  scenario: string;
  instance: string;
  event: string;
  atMs: number;
  status: number;
}[] = [];
const names = new Map<TestApp, string>();
const record = (app: TestApp, event: string, status: number) =>
  calls.push({
    scenario: "turn-token",
    instance: names.get(app) ?? "?",
    event,
    atMs: Math.round(performance.now() - startedAt),
    status,
  });

beforeAll(async () => {
  if (postgresUrl) scratch = await createScratchDatabase(postgresUrl);
}, 30_000);

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const app of apps.splice(0)) await app.server.close();
  for (const handle of handles.splice(0)) await handle.close();
});

afterAll(async () => {
  await scratch?.drop();
  const directory = process.env.PARLOR_CHECK_EVIDENCE;
  if (directory && calls.length > 0) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "calls.json"), `${JSON.stringify(calls, null, 2)}\n`);
  }
});

async function instance(name: string): Promise<TestApp> {
  const handle = await createDatabase({ url: scratch.url });
  handles.push(handle);
  const app = createTestApp(handle, { actions: tasks, plugins: [chat()] });
  apps.push(app);
  names.set(app, name);
  await app.server.fetch(new Request(`${ORIGIN}/_parlor/manifest`)).catch(() => {});
  return app;
}

async function mcpOn(app: TestApp, token: string): Promise<Client> {
  const client = new Client({ name: "proxy", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/_parlor/mcp`), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return app.server.fetch(new Request(input, { ...init, headers }));
      },
    }),
  );
  return client;
}

async function listTasksStatus(app: TestApp, token: string): Promise<number> {
  const response = await app.server.fetch(
    new Request(`${ORIGIN}/_parlor/actions/listTasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }),
  );
  await response.text();
  return response.status;
}

async function refusedWithin(
  attempt: () => Promise<number>,
  boundMs: number,
): Promise<number> {
  const started = performance.now();
  while ((await attempt()) !== 401) {
    if (performance.now() - started > boundMs) throw new Error("still accepted");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return performance.now() - started;
}

describe.runIf(postgresUrl)(
  "a turn token claimed on one instance and used on another",
  () => {
    it("lists the user's tasks on the second instance, and is refused there within 5 s of the revocation", async () => {
      const a = await instance("A");
      const b = await instance("B");
      const alice = await signUpAs(a.server, "Alice");
      const computer: Computer = await pair(a.server, alice);
      const { account, grant } = computer.grant!;
      await handles[0]!.db.execute(
        sql`create table tasks (id text primary key, scope text not null, title text not null, created_at timestamptz not null default now())`,
      );
      for (const [index, title] of TITLES.entries()) {
        await handles[0]!.db.execute(
          sql`insert into tasks (id, scope, title, created_at) values (${`seed-${index + 1}`}, ${account.userId}, ${title}, now() + ${index} * interval '1 second')`,
        );
      }

      const host = createFakeHost({
        origin: ORIGIN,
        authorize: async ({ method, url }) =>
          `ParlorHost ${await computer.assertion({ method: method === "GET" ? "GET" : "POST", url })}`,
        fetch: (input, init) => a.server.fetch(new Request(input, init)),
      });
      expect((await host.hello()).accepted).toBe(true);
      const sent = await alice.post("/_parlor/chat/actions/send", {
        threadId: "thr-1",
        turnId: "trn-1",
        itemId: "itm-1",
        clientId: "tab-1",
        prompt: {
          text: "what are my tasks?",
          agent: { hostId: grant.hostId, agentId: "claude" },
        },
      });
      expect(sent.status).toBe(200);

      const claimed = await host.claim();
      record(a, "hostClaim", claimed ? 200 : 404);
      expect(claimed?.turnId).toBe("trn-1");
      const token = claimed!.token.token;

      const mcp = await mcpOn(b, token);
      const result = await mcp.callTool({ name: "listTasks", arguments: {} });
      record(b, "listTasks", result.isError ? 500 : 200);
      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect((JSON.parse(text) as { title: string }[]).map((task) => task.title)).toEqual(
        TITLES,
      );

      const revoked = await alice.account("revokeHost", { hostId: grant.hostId });
      record(a, "revokeHost", revoked.status);
      expect(revoked.status).toBe(200);
      const latency = await refusedWithin(async () => {
        const status = await listTasksStatus(b, token);
        record(b, "listTasks", status);
        return status;
      }, REFUSAL_BOUND_MS);
      expect(latency).toBeLessThan(REFUSAL_BOUND_MS);
    });
  },
);
