import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { inProcessRelay, type LiveRelay } from "./live.js";
import {
  agentRef,
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

describe.each(drivers)("finishing a turn on $name", (driver) => {
  let handle: DatabaseHandle;
  let app: ChatServer;
  let settled: string[];

  beforeAll(async () => {
    handle = await openDatabase(driver);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    settled = [];
    const relay = (): LiveRelay => {
      const real = inProcessRelay();
      return {
        ...real,
        settle(owner, threadId, turnId) {
          settled.push(`${threadId}/${turnId}`);
          real.settle(owner, threadId, turnId);
        },
      };
    };
    app = serveChat(handle, { chat: { relay } });
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1.0.0",
      name: "Alice's Mac",
      platform: "darwin",
      agents: [],
    });
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab-1",
      prompt: { text: "hi", agent: agentRef },
    });
    await app.action("alice-host", "hostClaim", {});
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const finish = () =>
    app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });

  it("settles the live stream once the turn is committed done", async () => {
    expect((await finish()).status).toBe(200);
    expect(settled).toEqual(["t1/u1"]);
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "done" },
    ]);
  });

  it("does not settle the live stream when the commit fails", async () => {
    await rows(handle, "alter table sync_events rename to sync_events_off");

    const reply = await finish();

    expect(reply.status).toBe(500);
    expect(settled).toEqual([]);
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "running" },
    ]);
  });
});
