import { asId, type DataProvider } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { ActionAudit } from "@parlor/server";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditLog } from "./audit.js";
import { type Database, rowsOf } from "./database.js";
import { createTestApp, type TestApp } from "./testing/app.js";
import { signUp } from "./testing/app.js";
import { callWith, pair } from "./testing/computer.js";

let handle: DatabaseHandle;
let app: TestApp;
const provider = (): DataProvider => ({
  read: () => handle.db,
  transaction: (run) => handle.transaction(run),
});

const agentCall: ActionAudit = {
  at: Date.UTC(2026, 9, 20, 3, 0, 0),
  action: "deleteTask",
  principal: {
    kind: "agent",
    userId: asId("user", "alice"),
    grantId: asId("grant", "g-mac"),
    agent: { name: "Claude Code", verified: true },
    turn: {
      threadId: asId("thread", "thr-1"),
      turnId: asId("turn", "trn-1"),
      hostId: asId("host", "mac"),
      clientId: "tab-1",
    },
  },
  source: "agent",
  scope: "alice",
  inputDigest: "d1",
  stage: "ran",
  outcome: "ok",
  confirmation: "approved",
};

const rows = async () =>
  rowsOf<Record<string, unknown>>(
    await handle.db.execute(
      sql`select actor_kind, user_id, grant_id, host_id, thread_id, turn_id, agent_name, action, source, scope, input_digest, stage, outcome, confirmation, (extract(epoch from at) * 1000)::float8 as at from parlor_auth_audit order by id`,
    ),
  );

beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  app = createTestApp(handle);
  await callWith(app.server, "/_parlor/actions/ping", undefined);
}, 30_000);
afterAll(async () => {
  await app.server.close();
  await handle.close();
});
beforeEach(async () => {
  await (handle.db as unknown as Database).execute(sql`truncate parlor_auth_audit`);
});

describe("the audit log through the server", () => {
  it("records an inline agent's call with its turn and a call that stopped at the door", async () => {
    const alice = await signUp(app.server, "Alice");
    const computer = await pair(app.server, alice);
    const { grant, account } = computer.grant!;
    const { token } = await app.provider.delegate!(
      { kind: "host", userId: account.userId, grantId: grant.id, hostId: grant.hostId },
      {
        threadId: asId("thread", "thr-9"),
        turnId: asId("turn", "trn-9"),
        clientId: "tab-1",
        agent: "Claude Code",
        ttlMs: 60_000,
      },
    );

    const allowed = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `Bearer ${token}`,
    );
    const refused = await callWith(
      app.server,
      "/_parlor/actions/whoami",
      `ParlorHost ${await computer.assertion({ url: `http://localhost:3000/_parlor/actions/whoami` })}`,
    );
    await app.server.close();

    expect([allowed.status, refused.status]).toEqual([200, 403]);
    const recorded = (await rows()).filter((row) => row.action === "whoami");
    expect(
      recorded.map((row) => [
        row.actor_kind,
        row.turn_id,
        row.source,
        row.stage,
        row.outcome,
      ]),
    ).toEqual([
      ["agent", "trn-9", "agent", "ran", "ok"],
      ["host", null, "http", "refused", "forbidden"],
    ]);
    app = createTestApp(handle);
  });
});

describe("the audit log", () => {
  it("stores an inline agent's confirmed call with its turn", async () => {
    const log = createAuditLog(provider());
    log.record(agentCall);
    await log.stop();

    expect(await rows()).toEqual([
      {
        actor_kind: "agent",
        user_id: "alice",
        grant_id: "g-mac",
        host_id: "mac",
        thread_id: "thr-1",
        turn_id: "trn-1",
        agent_name: "Claude Code",
        action: "deleteTask",
        source: "agent",
        scope: "alice",
        input_digest: "d1",
        stage: "ran",
        outcome: "ok",
        confirmation: "approved",
        at: agentCall.at,
      },
    ]);
  });

  it("keeps an external agent's call without a turn, and a refused host call", async () => {
    const log = createAuditLog(provider());
    log.record({
      ...agentCall,
      principal: { ...(agentCall.principal as object), turn: undefined } as never,
      source: "mcp",
      confirmation: undefined,
    });
    log.record({
      ...agentCall,
      principal: {
        kind: "host",
        userId: asId("user", "alice"),
        grantId: asId("grant", "g-mac"),
        hostId: asId("host", "mac"),
      },
      action: "listTasks",
      source: "http",
      stage: "refused",
      outcome: "forbidden",
      confirmation: undefined,
    });
    await log.stop();

    expect(
      (await rows()).map((row) => [row.actor_kind, row.turn_id, row.stage, row.outcome]),
    ).toEqual([
      ["agent", null, "ran", "ok"],
      ["host", null, "refused", "forbidden"],
    ]);
  });

  it("leaves out the routine calls of signed-in users and hosts", async () => {
    const log = createAuditLog(provider());
    log.record({
      ...agentCall,
      principal: { kind: "user", userId: asId("user", "alice"), sessionId: "s1" },
      source: "ui",
      confirmation: undefined,
    });
    log.record({
      ...agentCall,
      principal: {
        kind: "host",
        userId: asId("user", "alice"),
        grantId: asId("grant", "g-mac"),
        hostId: asId("host", "mac"),
      },
      action: "hostSignals",
      source: "http",
      confirmation: undefined,
    });
    await log.stop();

    expect(await rows()).toEqual([]);
  });

  it("writes a burst of records in one transaction", async () => {
    let transactions = 0;
    const log = createAuditLog({
      read: () => handle.db,
      transaction: (run) => {
        transactions += 1;
        return handle.transaction(run);
      },
    });
    for (let call = 0; call < 40; call += 1)
      log.record({ ...agentCall, inputDigest: `d${call}` });
    await log.stop();

    expect(transactions).toBe(1);
    expect(await rows()).toHaveLength(40);
  });

  it("refuses to change or delete a record", async () => {
    const log = createAuditLog(provider());
    log.record(agentCall);
    await log.stop();

    await expect(
      handle.db.execute(sql`update parlor_auth_audit set outcome = 'ok'`),
    ).rejects.toThrow();
    await expect(handle.db.execute(sql`delete from parlor_auth_audit`)).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });

  it("keeps a batch that failed to write and writes it with the next one", async () => {
    let failing = true;
    const log = createAuditLog({
      read: () => handle.db,
      transaction: (run) =>
        failing ? Promise.reject(new Error("database away")) : handle.transaction(run),
    });
    log.record(agentCall);
    await log.flush().catch(() => {});
    failing = false;
    log.record({ ...agentCall, inputDigest: "d2" });
    await log.stop();

    expect((await rows()).map((row) => row.input_digest)).toEqual(["d1", "d2"]);
  });
});
