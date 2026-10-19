import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asId, type DataProvider, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Browser,
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { pair } from "./testing/computer.js";
import {
  createScratchDatabase,
  postgresUrl,
  revocationListeners,
  type ScratchDatabase,
  terminate,
} from "./testing/postgres.js";
import { probePlugin } from "./testing/probe.js";

const CALLS = 100;
const REFUSAL_BOUND_MS = 5000;

if (!postgresUrl) {
  console.info("[parlor] P6 probe skipped: set PARLOR_TEST_DATABASE_URL to run it");
}

let scratch: ScratchDatabase;
let handle: DatabaseHandle;
let app: TestApp;
let alice: Browser;
let queries = 0;
let listenRefused = false;

const counting = (provider: DataProvider): DataProvider => ({
  ...provider,
  read: () => {
    queries += 1;
    return provider.read();
  },
  transaction: (run) => {
    queries += 1;
    return provider.transaction(run);
  },
  listen: (channel, handler, options) =>
    listenRefused
      ? Promise.reject(new Error("LISTEN refused by the probe"))
      : provider.listen!(channel, handler, options),
});

beforeAll(async () => {
  if (!postgresUrl) return;
  scratch = await createScratchDatabase(postgresUrl);
  handle = await createDatabase({ url: scratch.url });
  app = createTestApp(handle, { plugins: [probePlugin], wrap: counting });
  alice = await signUpAs(app.server, "Alice");
}, 30_000);

afterAll(async () => {
  if (!postgresUrl) return;
  await app.server.close();
  await handle.close();
  await scratch.drop();
});

async function mint() {
  const computer = await pair(app.server, alice);
  const { grant, account } = computer.grant!;
  const principal: HostPrincipal = {
    kind: "host",
    userId: account.userId,
    grantId: grant.id,
    hostId: grant.hostId,
  };
  const { token } = await app.provider.delegate!(principal, {
    threadId: asId("thread", "thr-1"),
    turnId: asId("turn", "trn-1"),
    clientId: "tab-1",
    agent: "Claude Code",
    ttlMs: 600_000,
  });
  return { hostId: grant.hostId, token };
}

const request = (token: string) =>
  new Request(`${ORIGIN}/_parlor/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

async function authorizeOnce(token: string): Promise<{ ok: boolean; queries: number }> {
  const before = queries;
  const outcome = await app.provider.authenticate(request(token)).then(
    () => true,
    () => false,
  );
  return { ok: outcome, queries: queries - before };
}

async function hundredCalls(token: string): Promise<number[]> {
  const counts: number[] = [];
  for (let call = 0; call < CALLS; call += 1) {
    const result = await authorizeOnce(token);
    expect(result.ok).toBe(true);
    counts.push(result.queries);
  }
  return counts;
}

async function revocationLatency(hostId: string, token: string): Promise<number> {
  expect((await alice.account("revokeHost", { hostId })).status).toBe(200);
  const started = performance.now();
  while ((await authorizeOnce(token)).ok) {
    if (performance.now() - started > REFUSAL_BOUND_MS * 2)
      throw new Error("still accepted");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return performance.now() - started;
}

describe.runIf(postgresUrl)("authorizing an inline agent's MCP call", () => {
  it("costs no query while following, at most one while checking, and ends within 5 s of revocation", async () => {
    const following = await mint();
    await authorizeOnce(following.token);
    const followingCounts = await hundredCalls(following.token);
    const followingLatencyMs = await revocationLatency(following.hostId, following.token);

    const checking = await mint();
    await authorizeOnce(checking.token);
    listenRefused = true;
    await terminate(scratch.url, await revocationListeners(scratch.url));
    const started = performance.now();
    while ((await authorizeOnce(checking.token)).queries === 0) {
      if (performance.now() - started > REFUSAL_BOUND_MS) {
        throw new Error("the set never fell back to checking");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const checkingCounts = await hundredCalls(checking.token);
    const checkingLatencyMs = await revocationLatency(checking.hostId, checking.token);
    listenRefused = false;

    const evidence = {
      calls: CALLS,
      following: {
        queriesPerCall: followingCounts,
        revocationToRefusalMs: followingLatencyMs,
      },
      checking: {
        queriesPerCall: checkingCounts,
        revocationToRefusalMs: checkingLatencyMs,
      },
    };
    const directory = process.env.PARLOR_P6_EVIDENCE;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "p6.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }

    expect(followingCounts).toEqual(Array.from({ length: CALLS }, () => 0));
    expect(Math.max(...checkingCounts)).toBeLessThanOrEqual(1);
    expect(followingLatencyMs).toBeLessThan(REFUSAL_BOUND_MS);
    expect(checkingLatencyMs).toBeLessThan(REFUSAL_BOUND_MS);
  }, 60_000);
});
