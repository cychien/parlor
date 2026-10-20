import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LoggedItem } from "../items.js";
import type { ChatSnapshot } from "../model.js";
import {
  agentRef,
  type ChatServer,
  data,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

describe("reading the chat", () => {
  let handle: DatabaseHandle;
  let app: ChatServer;

  beforeAll(async () => {
    handle = await openDatabase({ name: "pglite" });
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    app = serveChat(handle);
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1",
      name: "Mac",
      platform: "darwin",
      agents: [{ id: "claude", name: "Claude", ready: true }],
    });
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const send = (threadId: string, turnId: string, text: string) =>
    app.action("alice", "send", {
      threadId,
      turnId,
      itemId: `${turnId}-prompt`,
      clientId: "tab",
      prompt: { text, agent: agentRef },
    });

  const finish = async (turnId: string, text: string) => {
    await app.action("alice-host", "hostClaim", {});
    await app.action("alice-host", "hostAppend", {
      turnId,
      items: [{ id: `${turnId}.1`, kind: "reply", body: { text } }],
    });
    await app.action("alice-host", "hostFinish", {
      turnId,
      outcome: { state: "done", stopReason: "end_turn" },
    });
  };

  const open = async (input: unknown) =>
    data(await app.action("alice", "open", input)) as ChatSnapshot;

  it("summarises threads newest first, titled by the first line of the first prompt", async () => {
    await send("t1", "u1", `${"a".repeat(100)}\nsecond line`);
    await finish("u1", "ok");
    await send("t2", "u2", "  Plan the trip  ");
    const snapshot = await open({});
    expect(
      snapshot.threads.map((thread) => [thread.id, thread.title, thread.lastSeq]),
    ).toEqual([
      ["t2", "Plan the trip", 1],
      ["t1", "a".repeat(80), 2],
    ]);
    expect(snapshot.threads[0]?.agent).toEqual({ hostId: "mac", agentId: "claude" });
    expect(snapshot.page.thread?.id).toBe("t2");
  });

  it("returns the last page of a thread, in order, and says when there is more", async () => {
    await send("t1", "u1", "one");
    await finish("u1", "first answer");
    await send("t1", "u2", "two");
    const page = (await open({ threadId: "t1", limit: 2 })).page;
    expect(page.items.map((item) => [item.seq, item.kind])).toEqual([
      [2, "reply"],
      [3, "prompt"],
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.turns).toEqual([
      { turnId: "u1", state: "done", agent: { hostId: "mac", agentId: "claude" } },
      { turnId: "u2", state: "queued", agent: { hostId: "mac", agentId: "claude" } },
    ]);
    const all = (await open({ threadId: "t1" })).page;
    expect(all.items).toHaveLength(3);
    expect(all.hasMore).toBe(false);
  });

  it("returns the items after a sequence number", async () => {
    await send("t1", "u1", "one");
    await finish("u1", "answer");
    const after = data(
      await app.action("alice", "items", { threadId: "t1", afterSeq: 1 }),
    ) as LoggedItem[];
    expect(after.map((item) => [item.seq, item.kind, item.id])).toEqual([
      [2, "reply", "u1.1"],
    ]);
    expect(
      data(await app.action("alice", "items", { threadId: "t1", afterSeq: 2 })),
    ).toEqual([]);
  });

  it("shows a turn whose host stopped renewing its lease as failed", async () => {
    await app.server.close();
    app = serveChat(handle, { chat: { leaseMs: 1 } });
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1",
      name: "Mac",
      platform: "darwin",
      agents: [],
    });
    await send("t1", "u1", "hi");
    await app.action("alice-host", "hostClaim", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const page = (await open({ threadId: "t1" })).page;
    expect(page.turns.map((turn) => turn.state)).toEqual(["failed"]);
  });

  it("carries what streams now, and drops it once the turn ended", async () => {
    await send("t1", "u1", "hi");
    await app.action("alice-host", "hostClaim", {});
    await app.post("alice-host", "stream", {
      turnId: "u1",
      frames: [
        { type: "delta", itemId: "u1.1", kind: "reply", offset: 0, text: "Hel" },
        {
          type: "item",
          item: { id: "u1.2", kind: "tool", title: "Creating", status: "running" },
        },
      ],
    });
    expect((await open({ threadId: "t1" })).page.open).toEqual([
      {
        turnId: "u1",
        threadId: "t1",
        items: [
          { id: "u1.1", kind: "reply", text: "Hel" },
          { id: "u1.2", kind: "tool", title: "Creating", status: "running" },
        ],
      },
    ]);
    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "cancelled" },
    });
    expect((await open({ threadId: "t1" })).page.open).toEqual([]);
  });

  it("lists the user's computers with their agents", async () => {
    expect(data(await app.action("alice", "hosts", {}))).toEqual([
      {
        id: "mac",
        name: "Mac",
        platform: "darwin",
        online: true,
        agents: [{ id: "claude", name: "Claude", ready: true }],
      },
    ]);
  });
});
