import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

const hello = (name: string) => ({
  protocols: { min: 1, max: 1 },
  hostVersion: "1.0.0",
  name,
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
});

describe.each(drivers)("chat isolation on $name", (driver) => {
  let handle: DatabaseHandle;
  let app: ChatServer;

  beforeAll(async () => {
    handle = await openDatabase(driver);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    app = serveChat(handle);
    await app.action("alice-host", "hostHello", hello("Alice's Mac"));
    await app.action("bob-host", "hostHello", hello("Bob's Mac"));
    await send("alice", "t-alice", "u1", agentRef.hostId);
    await app.action("alice-host", "hostClaim", {});
    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });
    await send("alice", "t-alice", "u2", agentRef.hostId);
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const send = (token: string, threadId: string, turnId: string, hostId: string) =>
    app.action(token, "send", {
      threadId,
      turnId,
      itemId: `${turnId}-prompt`,
      clientId: "tab",
      prompt: { text: "hi", agent: { hostId, agentId: "claude" } },
    });

  it("gives Bob an empty sidebar with only his own computer", async () => {
    const opened = await app.action("bob", "open", { threadId: "t-alice" });
    expect(opened.status).toBe(200);
    expect(data(opened)).toEqual({
      threads: [],
      hosts: [
        {
          id: "bob-mac",
          name: "Bob's Mac",
          platform: "darwin",
          online: true,
          agents: [{ id: "claude", name: "Claude", ready: true }],
        },
      ],
      page: { thread: undefined, items: [], open: [], turns: [], hasMore: false },
    });
    const alices = data(await app.action("alice", "open", {})) as {
      threads: { id: string }[];
      page: { items: unknown[] };
    };
    expect(alices.threads.map((thread) => thread.id)).toEqual(["t-alice"]);
    expect(alices.page.items).toHaveLength(2);
  });

  it("answers Alice's thread and a random thread with the same 404, byte for byte", async () => {
    const calls: [string, (threadId: string) => unknown][] = [
      ["items", (threadId) => ({ threadId, afterSeq: 0 })],
      ["cancel", (threadId) => ({ threadId, turnId: "u2", itemId: "c-bob" })],
      [
        "answer",
        (threadId) => ({
          threadId,
          turnId: "u2",
          itemId: "a-bob",
          answer: { askId: "x", choice: "yes" },
        }),
      ],
    ];
    for (const [name, input] of calls) {
      const stolen = await app.action("bob", name, input("t-alice"));
      const random = await app.action("bob", name, input("t-nobody"));
      expect(stolen.status, name).toBe(404);
      expect(stolen.text, name).toBe(random.text);
      expect(stolen.body, name).toMatchObject({ error: { code: "not_found" } });
    }
    expect(await rows(handle, "select kind from parlor_chat_items order by seq")).toEqual(
      [{ kind: "prompt" }, { kind: "prompt" }],
    );
  });

  it("refuses a prompt to Alice's computer exactly like one to a computer that does not exist", async () => {
    const stolen = await send("bob", "t-bob", "bu1", "mac");
    const random = await send("bob", "t-bob", "bu1", "no-such-computer");
    expect(stolen.status).toBe(404);
    expect(stolen.text).toBe(random.text);
    expect(await rows(handle, "select id from parlor_chat_threads order by id")).toEqual([
      { id: "t-alice" },
    ]);
  });

  it("refuses a prompt on Alice's thread even to Bob's own computer", async () => {
    const reply = await send("bob", "t-alice", "bu1", "bob-mac");
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({
      error: { code: "not_found", message: "Thread not found" },
    });
    expect(await rows(handle, "select id from parlor_chat_turns order by id")).toEqual([
      { id: "u1" },
      { id: "u2" },
    ]);
  });

  it("keeps Bob's computer away from Alice's queued turn until her own computer takes it", async () => {
    const bobs = await app.action("bob-host", "hostClaim", {});
    expect(bobs.status).toBe(404);
    const alices = await app.action("alice-host", "hostClaim", {});
    expect(data(alices)).toMatchObject({ turnId: "u2", id: "t-alice" });
  });

  it("keeps Bob's computer out of Alice's running turn", async () => {
    await app.action("alice-host", "hostClaim", {});
    const append = (turnId: string) =>
      app.action("bob-host", "hostAppend", {
        turnId,
        items: [{ id: `${turnId}.1`, kind: "reply", body: { text: "x" } }],
      });
    const stolen = await append("u2");
    const random = await append("u-nobody");
    expect(stolen.status).toBe(404);
    expect(stolen.text).toBe(random.text);
    const finish = await app.action("bob-host", "hostFinish", {
      turnId: "u2",
      outcome: { state: "cancelled" },
    });
    expect(finish.status).toBe(404);
    const signals = await app.action("bob-host", "hostSignals", {
      turns: [{ turnId: "u2", afterSeq: 0 }],
    });
    expect(data(signals)).toEqual([]);
  });

  it("keeps two users of one scope apart, whatever the app calls a scope", async () => {
    await app.server.close();
    await resetDatabase(handle);
    app = serveChat(handle, { scope: () => "acme" });
    await app.action("alice-host", "hostHello", hello("Alice's Mac"));
    await app.action("bob-host", "hostHello", hello("Bob's Mac"));
    await send("alice", "t-alice", "u1", "mac");
    const opened = data(await app.action("bob", "open", {})) as {
      threads: unknown[];
      hosts: { id: string }[];
    };
    expect(opened.threads).toEqual([]);
    expect(opened.hosts.map((host) => host.id)).toEqual(["bob-mac"]);
    expect(
      (await app.action("bob", "items", { threadId: "t-alice", afterSeq: 0 })).status,
    ).toBe(404);
    expect((await app.action("bob-host", "hostClaim", {})).status).toBe(404);
  });
});
