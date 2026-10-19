import type { DatabaseHandle } from "@parlor/data";
import { SYNC_CHANNEL } from "@parlor/sync";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  type Counted,
  counted,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

const SECRET = "the-secret-reply-text";

describe.each(drivers)("the chat's database writes on $name", (driver) => {
  let handle: DatabaseHandle;
  let provider: Counted;
  let app: ChatServer;
  let payloads: string[];
  let stopListening: () => Promise<void>;

  beforeAll(async () => {
    handle = await openDatabase(driver);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    provider = counted(handle);
    app = serveChat(provider);
    payloads = [];
    await app.action("alice-host", "hostHello", {
      protocols: { min: 1, max: 1 },
      hostVersion: "1",
      name: "Mac",
      platform: "darwin",
      agents: [],
    });
    stopListening = await handle.listen(SYNC_CHANNEL, (payload) =>
      payloads.push(payload),
    );
  }, 60_000);

  afterEach(async () => {
    await stopListening();
    await app.server.close();
  });

  const delta = (n: number) => ({
    type: "delta",
    itemId: "u1.1",
    kind: "reply",
    offset: n * 5,
    text: `${SECRET.slice(0, 5)}`,
  });

  it("commits a turn in at most its completed items plus two transactions, none for deltas", async () => {
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: SECRET, agent: agentRef },
    });
    provider.resetCount();

    await app.action("alice-host", "hostClaim", {});
    expect(provider.transactions).toBe(1);

    for (let batch = 0; batch < 20; batch += 1) {
      const frames = Array.from({ length: 5 }, (_, n) => delta(batch * 5 + n));
      const reply = await app.post("alice-host", "stream", { turnId: "u1", frames });
      expect(reply.status).toBe(204);
    }
    await app.action("alice-host", "hostSignals", {
      turns: [{ turnId: "u1", afterSeq: 1 }],
    });
    await app.post("alice-host", "heartbeat", {});
    expect(provider.transactions).toBe(1);

    const completed = [
      { id: "u1.1", kind: "reply", body: { text: SECRET } },
      {
        id: "u1.2",
        kind: "tool",
        body: {
          title: "Created task",
          tool: { kind: "app", name: "createTask" },
          status: "done",
        },
      },
    ];
    for (const item of completed) {
      await app.action("alice-host", "hostAppend", { turnId: "u1", items: [item] });
    }
    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });
    expect(provider.transactions).toBe(completed.length + 2);
  });

  it("puts only thread ids in the notifications, never a prompt or reply", async () => {
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: SECRET, agent: agentRef },
    });
    await app.action("alice-host", "hostClaim", {});
    await app.post("alice-host", "stream", { turnId: "u1", frames: [delta(0)] });
    await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [{ id: "u1.1", kind: "reply", body: { text: SECRET } }],
    });
    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(payloads.length).toBe(4);
    for (const payload of payloads) {
      expect(payload).not.toContain(SECRET.slice(0, 5));
      const { event } = JSON.parse(payload) as { event: { tags: unknown[] } };
      expect(event.tags).toEqual([["parlor_chat", "t1"]]);
    }
  });

  it("records no event when a claim finds nothing", async () => {
    const before = await rows(handle, "select count(*)::int as n from sync_events");
    const claim = await app.action("alice-host", "hostClaim", {});
    expect(claim.status).toBe(404);
    expect(await rows(handle, "select count(*)::int as n from sync_events")).toEqual(
      before,
    );
    expect(data(await app.action("alice-host", "hostSignals", { turns: [] }))).toEqual(
      [],
    );
  });
});
