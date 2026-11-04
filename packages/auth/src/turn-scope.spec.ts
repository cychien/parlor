import { asId, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApp, signUp, type TestApp } from "./testing/app.js";
import { pair } from "./testing/computer.js";

let database: DatabaseHandle;
let app: TestApp;

beforeEach(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  app = createTestApp(database);
}, 30_000);

afterEach(async () => {
  await app.server.close();
  await database.close();
});

async function turnPrincipal(
  scopeOf: (userId: string) => string | undefined,
): Promise<{ readonly status: number; readonly principal?: unknown }> {
  const alice = await signUp(app.server, "Alice");
  const { grant, account } = (await pair(app.server, alice)).grant!;
  const host: HostPrincipal = {
    kind: "host",
    userId: account.userId,
    grantId: grant.id,
    hostId: grant.hostId,
  };
  const { token } = await app.provider.delegate!(host, {
    threadId: asId("thread", "thr-1"),
    turnId: asId("turn", "trn-1"),
    clientId: "tab-1",
    agent: "Claude Code",
    ttlMs: 60_000,
    ...(scopeOf(account.userId) === undefined ? {} : { scope: scopeOf(account.userId) }),
  });
  const response = await app.server.fetch(
    new Request("http://localhost:3000/_parlor/actions/whoami", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    }),
  );
  if (response.status !== 200) return { status: response.status };
  const { data } = (await response.json()) as { data: { principal: unknown } };
  return { status: 200, principal: data.principal };
}

describe("a turn token", () => {
  it("carries the scope of the conversation it was minted for", async () => {
    const { status, principal } = await turnPrincipal((userId) => userId);
    expect(status).toBe(200);
    expect(principal).toMatchObject({
      kind: "agent",
      turn: { threadId: "thr-1", turnId: "trn-1", scope: expect.any(String) },
    });
  });

  it("is refused in any scope but that one", async () => {
    expect((await turnPrincipal(() => "org:acme")).status).toBe(403);
  });

  it("minted without a scope binds none", async () => {
    const { principal } = await turnPrincipal(() => undefined);
    expect((principal as { turn: object }).turn).not.toHaveProperty("scope");
  });
});
