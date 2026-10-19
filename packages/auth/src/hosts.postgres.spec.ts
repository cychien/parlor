import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { asId, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { rowsOf } from "./database.js";
import {
  type Browser,
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { callWith, type Computer, HELLO, pair } from "./testing/computer.js";
import {
  connect,
  createScratchDatabase,
  postgresUrl,
  revocationListeners,
  type ScratchDatabase,
  terminate,
} from "./testing/postgres.js";
import { probePlugin } from "./testing/probe.js";

const REFUSAL_BOUND_MS = 5000;

if (!postgresUrl) {
  console.info(
    "[parlor] multi-instance host specs skipped: set PARLOR_TEST_DATABASE_URL to run them",
  );
}

let scratch: ScratchDatabase;
const handles: DatabaseHandle[] = [];
const apps: TestApp[] = [];
const clients: Client[] = [];

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
});

async function instance(): Promise<TestApp> {
  const handle = await createDatabase({ url: scratch.url });
  handles.push(handle);
  const app = createTestApp(handle, { plugins: [probePlugin] });
  apps.push(app);
  await callWith(app.server, "/_parlor/actions/ping", undefined);
  return app;
}

const hello = async (app: TestApp, computer: Computer) =>
  callWith(
    app.server,
    HELLO,
    `ParlorHost ${await computer.assertion({ url: `${ORIGIN}${HELLO}` })}`,
  );

async function pairedOn(app: TestApp): Promise<{ alice: Browser; computer: Computer }> {
  const alice = await signUpAs(app.server, "Alice");
  return { alice, computer: await pair(app.server, alice) };
}

const hostOf = (computer: Computer): HostPrincipal => ({
  kind: "host",
  userId: computer.grant!.account.userId,
  grantId: computer.grant!.grant.id,
  hostId: computer.grant!.grant.hostId,
});

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

describe.runIf(postgresUrl).each([
  { mode: "following", killListener: false },
  { mode: "checking", killListener: true },
])("a revoked computer on a second instance, $mode", ({ killListener }) => {
  it("is refused within 5 s and never accepted again", async () => {
    const b = await instance();
    const listeners = await revocationListeners(scratch.url);
    expect(listeners).toHaveLength(1);
    const a = await instance();
    const { alice, computer } = await pairedOn(a);
    expect((await hello(b, computer)).status).toBe(200);

    if (killListener) await terminate(scratch.url, listeners);
    const revoked = await alice.account("revokeHost", {
      hostId: computer.grant!.grant.hostId,
    });
    expect(revoked.status).toBe(200);

    const latency = await refusedWithin(
      async () => (await hello(b, computer)).status,
      REFUSAL_BOUND_MS,
    );
    expect(latency).toBeLessThan(REFUSAL_BOUND_MS);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await hello(b, computer)).status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

describe.runIf(postgresUrl)("revoking a computer", () => {
  it("commits the revocation and the key's removal together", async () => {
    const a = await instance();
    const { alice, computer } = await pairedOn(a);
    const { id, hostId } = computer.grant!.grant;
    const state = async () =>
      rowsOf<{ hosts: number; revocations: number }>(
        await handles[0]!.db.execute(sql`
          select
            (select count(*)::int from parlor_auth_hosts where grant_id = ${id}) as hosts,
            (select count(*)::int from parlor_auth_revocations where id = ${id}) as revocations`),
      )[0];

    const locker = await connect(scratch.url);
    try {
      await locker.query("begin");
      await locker.query(
        "lock table parlor_auth_revocations in share row exclusive mode",
      );
      const pending = alice.account("revokeHost", { hostId });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await state()).toEqual({ hosts: 1, revocations: 0 });
      await locker.query("commit");
      expect((await pending).status).toBe(200);
    } finally {
      await locker.end();
    }
    expect(await state()).toEqual({ hosts: 0, revocations: 1 });
  });
});

describe.runIf(postgresUrl)("a turn token across instances", () => {
  const turn = (app: TestApp, principal: HostPrincipal) =>
    app.provider.delegate!(principal, {
      threadId: asId("thread", "thr-1"),
      turnId: asId("turn", "trn-1"),
      clientId: "tab-1",
      agent: "Claude Code",
      ttlMs: 120_000,
    });

  it("minted on one instance is accepted on another, and refused there once revoked", async () => {
    const a = await instance();
    const b = await instance();
    const { alice, computer } = await pairedOn(a);
    const { token } = await turn(a, hostOf(computer));

    const mcp = new Client({ name: "proxy", version: "0.0.0" });
    clients.push(mcp);
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/_parlor/mcp`), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${token}`);
          return b.server.fetch(new Request(input, { ...init, headers }));
        },
      }),
    );
    const result = await mcp.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      source: "agent",
      principal: { kind: "agent", turn: { threadId: "thr-1", turnId: "trn-1" } },
    });

    await alice.account("revokeHost", { hostId: computer.grant!.grant.hostId });
    const latency = await refusedWithin(
      async () => (await callWith(b.server, HELLO, `Bearer ${token}`)).status,
      REFUSAL_BOUND_MS,
    );
    expect(latency).toBeLessThan(REFUSAL_BOUND_MS);
  });

  it("is signed by one key even when two instances start minting together", async () => {
    const a = await instance();
    const b = await instance();
    const { computer } = await pairedOn(a);
    const principal = hostOf(computer);
    const [fromA, fromB] = await Promise.all([turn(a, principal), turn(b, principal)]);
    const keys = rowsOf<{ active: boolean }>(
      await handles[0]!.db.execute(sql`select active from parlor_auth_turn_keys`),
    );
    expect(keys).toEqual([{ active: true }]);
    for (const { token } of [fromA, fromB]) {
      for (const app of [a, b]) {
        expect((await callWith(app.server, HELLO, `Bearer ${token}`)).status).toBe(403);
      }
    }
  });
});
