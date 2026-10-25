import type { DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ChatAccessRequest } from "./index.js";
import {
  agentRef,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";
import type { ChatDb } from "./store.js";

const hello = {
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name: "Mac",
  platform: "darwin",
  agents: [],
};

const prompt = (turnId: string) => ({
  threadId: "t1",
  turnId,
  itemId: `${turnId}.p`,
  clientId: "tab",
  prompt: { text: "hi", agent: agentRef },
});

const USER_ACTIONS: Readonly<Record<string, unknown>> = {
  open: {},
  items: { threadId: "t1", afterSeq: 0 },
  history: { threadId: "t1", beforeSeq: 1 },
  threadsBefore: { before: { updatedAt: 0, id: "t1" } },
  hosts: {},
  send: prompt("u1"),
  answer: {
    threadId: "t1",
    turnId: "u1",
    itemId: "a1",
    answer: { askId: "ask", choice: "allow" },
  },
  cancel: { threadId: "t1", turnId: "u1", itemId: "c1" },
  userActive: {},
};

const HOST_ACTIONS: Readonly<Record<string, unknown>> = {
  hostHello: hello,
  hostReport: { online: true, agents: [] },
  hostClaim: {},
  hostSignals: { turns: [] },
  hostAppend: { turnId: "u1", items: [] },
  hostFinish: { turnId: "u1", outcome: { state: "cancelled" } },
};

describe.each(drivers)("chat({ access }) on $name", (driver) => {
  let handle: DatabaseHandle;
  let app: ChatServer;
  let asked: ChatAccessRequest[];

  beforeAll(async () => {
    handle = await openDatabase(driver);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await resetDatabase(handle);
    await handle.db.execute(sql`create table app_admins (user_id text primary key)`);
    await handle.db.execute(sql`insert into app_admins values ('alice')`);
    asked = [];
    app = serveChat(handle, {
      chat: {
        access: async (request) => {
          asked.push(request);
          const found = await (request.database.read() as ChatDb).execute(
            sql`select 1 from app_admins where user_id = ${request.userId}`,
          );
          return (found as { rows: unknown[] }).rows.length > 0;
        },
      },
    });
  }, 60_000);
  afterEach(async () => {
    await app.server.close();
  });

  const refused = { status: 403, body: { error: { code: "forbidden" } } };

  it("refuses every user action to a user the policy refuses", async () => {
    for (const [name, input] of Object.entries(USER_ACTIONS)) {
      expect(await app.action("bob", name, input), name).toMatchObject(refused);
    }
  });

  it("refuses every host action and route to a computer of a refused user", async () => {
    for (const [name, input] of Object.entries(HOST_ACTIONS)) {
      expect(await app.action("bob-host", name, input), name).toMatchObject(refused);
    }
    expect(await app.post("bob-host", "heartbeat", {})).toMatchObject(refused);
    expect(
      await app.post("bob-host", "stream", { turnId: "u1", frames: [] }),
    ).toMatchObject(refused);
  });

  it("asks with the user a computer works for, its principal, scope and database", async () => {
    await app.action("bob-host", "hostHello", hello);
    expect(asked).toHaveLength(1);
    const [request] = asked;
    expect(request).toMatchObject({
      userId: "bob",
      principal: { kind: "host", userId: "bob" },
      scope: "bob",
    });
    expect(typeof request!.database.read).toBe("function");
  });

  it("lets an allowed user chat with their computer end to end", async () => {
    expect((await app.action("alice", "open", {})).status).toBe(200);
    expect(data(await app.action("alice-host", "hostHello", hello))).toMatchObject({
      accepted: true,
    });
    expect((await app.action("alice", "send", prompt("u1"))).status).toBe(200);
    expect(data(await app.action("alice-host", "hostClaim", {}))).toMatchObject({
      turnId: "u1",
      token: { token: expect.any(String) },
    });
    expect((await app.post("alice-host", "heartbeat", {})).status).toBe(204);
    expect(
      (
        await app.action("alice-host", "hostFinish", {
          turnId: "u1",
          outcome: { state: "done", stopReason: "end_turn" },
        })
      ).status,
    ).toBe(200);
  });

  it("stops a computer taking turns once its user is refused", async () => {
    await app.action("alice-host", "hostHello", hello);
    await app.action("alice", "send", prompt("u1"));
    await app.action("alice-host", "hostClaim", {});
    await handle.db.execute(sql`delete from app_admins`);

    expect(
      await app.action("alice-host", "hostAppend", { turnId: "u1", items: [] }),
    ).toMatchObject(refused);
    expect(
      await app.post("alice-host", "stream", { turnId: "u1", frames: [] }),
    ).toMatchObject(refused);
    expect(await app.action("alice", "send", prompt("u2"))).toMatchObject(refused);
    expect(app.auth.delegated).toHaveLength(1);
  });

  it("refuses nobody when no policy is set", async () => {
    const open = serveChat(handle);
    try {
      expect((await open.action("bob", "open", {})).status).toBe(200);
    } finally {
      await open.server.close();
    }
  });
});
