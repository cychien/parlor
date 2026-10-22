import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  alice,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  type Reply,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

const HELLO = {
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name: "Alice's Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
};

describe.each(drivers)("exactly-once turns on $name", (driver) => {
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
    app = serveChat(handle, { chat: { leaseMs: 60_000, maxQueued: 4 } });
    const welcome = await app.action("alice-host", "hostHello", HELLO);
    expect(welcome.status).toBe(200);
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const send = (
    threadId: string,
    turnId: string,
    itemId = `${turnId}-prompt`,
    text = "hello",
  ): Promise<Reply> =>
    app.action("alice", "send", {
      threadId,
      turnId,
      itemId,
      clientId: "tab-1",
      prompt: { text, agent: agentRef },
    });

  const claim = () => app.action("alice-host", "hostClaim", {});
  const reply = (turnId: string, n: number, text = `part ${n}`) => ({
    id: `${turnId}.${n}`,
    kind: "reply",
    body: { text },
  });

  it("gives each of 100 queued turns to exactly one of two concurrent claims", async () => {
    for (let round = 0; round < 100; round += 1) {
      const sent = await send(`thread-${round}`, `turn-${round}`);
      expect(sent.status).toBe(200);
      const claims = await Promise.all([claim(), claim()]);
      expect(claims.map((c) => c.status).sort()).toEqual([200, 404]);
      const won = claims.find((c) => c.status === 200);
      const lost = claims.find((c) => c.status === 404);
      expect(data(won as Reply)).toMatchObject({
        id: `thread-${round}`,
        turnId: `turn-${round}`,
      });
      expect(lost?.body).toEqual({
        error: { code: "not_found", message: "No turn is waiting." },
      });
    }
    expect(await rows(handle, "select state from parlor_chat_turns")).toHaveLength(100);
    expect(
      await rows(handle, "select 1 from parlor_chat_turns where state = 'running'"),
    ).toHaveLength(100);
  }, 120_000);

  it("hands over the prompt, a token bound to the turn and the context in one claim", async () => {
    await send("t1", "u1", "p1", "add a task");
    const claimed = data(await claim()) as {
      id: string;
      turnId: string;
      clientId: string;
      agent: unknown;
      prompt: { id: string; seq: number; body: { text: string } };
      token: { token: string };
      context: string;
      leaseUntil: number;
    };
    expect(claimed).toMatchObject({
      id: "t1",
      turnId: "u1",
      clientId: "tab-1",
      agent: { hostId: "mac", agentId: "claude" },
      prompt: { id: "p1", seq: 1, body: { text: "add a task" } },
      token: { token: "turn.u1.1" },
    });
    expect(claimed.context).toContain("for Alice.");
    expect(claimed.leaseUntil).toBeGreaterThan(Date.now() + 50_000);
    expect(claimed.leaseUntil).toBeLessThan(Date.now() + 61_000);
    expect(app.auth.delegated).toEqual([
      {
        hostId: "mac",
        threadId: "t1",
        turnId: "u1",
        clientId: "tab-1",
        agent: "Claude",
        ttlMs: 60_000,
      },
    ]);
  });

  it("leaves one row for items appended twice, and numbers the log without gaps", async () => {
    await send("t1", "u1");
    await claim();
    const first = { turnId: "u1", items: [reply("u1", 1), reply("u1", 2)] };
    expect((await app.action("alice-host", "hostAppend", first)).status).toBe(200);
    const retried = { turnId: "u1", items: [reply("u1", 2), reply("u1", 3)] };
    expect((await app.action("alice-host", "hostAppend", retried)).status).toBe(200);
    expect((await app.action("alice-host", "hostAppend", first)).status).toBe(200);
    expect(
      await rows(
        handle,
        "select id, seq::int as seq from parlor_chat_items order by seq",
      ),
    ).toEqual([
      { id: "u1-prompt", seq: 1 },
      { id: "u1.1", seq: 2 },
      { id: "u1.2", seq: 3 },
      { id: "u1.3", seq: 4 },
    ]);
    expect(
      await rows(handle, "select last_seq::int as last_seq from parlor_chat_threads"),
    ).toEqual([{ last_seq: 4 }]);
  });

  it("renews the lease and the turn token with each append", async () => {
    await send("t1", "u1");
    await claim();
    const appended = data(
      await app.action("alice-host", "hostAppend", {
        turnId: "u1",
        items: [reply("u1", 1)],
      }),
    ) as { id: string; token: { token: string }; leaseUntil: number };
    expect(appended).toMatchObject({ id: "t1", token: { token: "turn.u1.2" } });
    expect(app.auth.delegated.map((d) => d.turnId)).toEqual(["u1", "u1"]);
  });

  it("finishes a turn once and keeps the first outcome", async () => {
    await send("t1", "u1");
    await claim();
    const done = await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });
    expect(done.status).toBe(200);
    const again = await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "failed", reason: "agent_exited" },
    });
    expect(again.status).toBe(403);
    expect(again.body).toEqual({
      error: { code: "forbidden", message: "The turn is not running." },
    });
    expect(await rows(handle, "select state, outcome from parlor_chat_turns")).toEqual([
      { state: "done", outcome: { state: "done", stopReason: "end_turn" } },
    ]);
    const late = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [reply("u1", 1)],
    });
    expect(late.status).toBe(403);
  });

  it("keeps one prompt and one turn when a send is retried", async () => {
    expect((await send("t1", "u1", "p1")).status).toBe(200);
    expect((await send("t1", "u1", "p1")).status).toBe(200);
    expect(
      await rows(handle, "select id, kind, seq::int as seq from parlor_chat_items"),
    ).toEqual([{ id: "p1", kind: "prompt", seq: 1 }]);
    expect(await rows(handle, "select id, state from parlor_chat_turns")).toEqual([
      { id: "u1", state: "queued" },
    ]);
  });

  it("keeps a retried send a no-op after the turn started", async () => {
    await send("t1", "u1", "p1");
    await claim();
    expect((await send("t1", "u1", "p1")).status).toBe(200);
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "running" },
    ]);
    expect(await rows(handle, "select 1 from parlor_chat_items")).toHaveLength(1);
  });

  it("runs a thread's turns one at a time, in the order they were sent", async () => {
    await send("t1", "u1");
    await send("t1", "u2");
    expect(data(await claim())).toMatchObject({ turnId: "u1" });
    expect((await claim()).status).toBe(404);
    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });
    expect(data(await claim())).toMatchObject({ turnId: "u2" });
  });

  it("refuses a fifth waiting prompt on one thread and counts only new turns", async () => {
    for (const n of [1, 2, 3, 4]) expect((await send("t1", `u${n}`)).status).toBe(200);
    const fifth = await send("t1", "u5");
    expect(fifth.status).toBe(400);
    expect(fifth.body).toMatchObject({ error: { code: "invalid_input" } });
    expect((await send("t1", "u4")).status).toBe(200);
  });

  it("cancels a queued turn at once and never hands it to the host", async () => {
    await send("t1", "u1");
    const cancelled = await app.action("alice", "cancel", {
      threadId: "t1",
      turnId: "u1",
      itemId: "c1",
    });
    expect(cancelled.status).toBe(200);
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "cancelled" },
    ]);
    expect((await claim()).status).toBe(404);
  });

  it("shows a running turn a cancel through hostSignals, after the cursor", async () => {
    await send("t1", "u1");
    await claim();
    await app.action("alice", "cancel", { threadId: "t1", turnId: "u1", itemId: "c1" });
    const signals = data(
      await app.action("alice-host", "hostSignals", {
        turns: [{ turnId: "u1", afterSeq: 1 }],
      }),
    );
    expect(signals).toMatchObject([
      { turnId: "u1", items: [{ id: "c1", kind: "cancel", seq: 2 }] },
    ]);
    expect(
      data(
        await app.action("alice-host", "hostSignals", {
          turns: [{ turnId: "u1", afterSeq: 2 }],
        }),
      ),
    ).toEqual([]);
  });

  it("takes one answer per question and shows it to the host", async () => {
    await send("t1", "u1");
    await claim();
    await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [
        {
          id: "u1.1",
          kind: "ask",
          body: {
            question: "Run it?",
            choices: [{ id: "yes", label: "Yes", effect: "allow_once" }],
          },
        },
      ],
    });
    const answer = (itemId: string) =>
      app.action("alice", "answer", {
        threadId: "t1",
        turnId: "u1",
        itemId,
        answer: { askId: "u1.1", choice: "yes" },
      });
    expect((await answer("a1")).status).toBe(200);
    expect((await answer("a1")).status).toBe(200);
    const second = await answer("a2");
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ error: { code: "invalid_input" } });
    expect(
      await rows(handle, "select id from parlor_chat_items where kind = 'answer'"),
    ).toEqual([{ id: "a1" }]);
    const ghost = await app.action("alice", "answer", {
      threadId: "t1",
      turnId: "u1",
      itemId: "a3",
      answer: { askId: "nope", choice: "yes" },
    });
    expect(ghost.status).toBe(404);
  });

  it("tells the sidebar why a turn failed", async () => {
    await send("t1", "u1");
    await claim();
    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "failed", reason: "prompt_expired" },
    });
    const opened = data(await app.action("alice", "open", { threadId: "t1" })) as {
      page: { turns: unknown[] };
    };
    expect(opened.page.turns).toEqual([
      {
        turnId: "u1",
        state: "failed",
        agent: agentRef,
        failure: "prompt_expired",
      },
    ]);
  });

  describe("answers to a question the host asked", () => {
    const ask = (approval?: "presence" | "computer") =>
      app.action("alice-host", "hostAppend", {
        turnId: "u1",
        items: [
          {
            id: "u1.1",
            kind: "ask",
            body: {
              question: "Run it?",
              choices: [{ id: "yes", label: "Yes", effect: "allow_once" }],
              ...(approval ? { approval } : {}),
            },
          },
        ],
      });
    const answer = (itemId: string, signed?: unknown) =>
      app.action("alice", "answer", {
        threadId: "t1",
        turnId: "u1",
        itemId,
        answer: { askId: "u1.1", choice: "yes", ...(signed ? { signed } : {}) },
      });
    const signature = (format: "es256-raw" | "webauthn", presence: "none" | "user") => ({
      deviceId: "device-1",
      at: 1,
      signature: { keyId: "key-1", presence, format, signature: "c2ln" },
    });
    const answers = () =>
      rows(handle, "select id from parlor_chat_items where kind = 'answer' order by seq");

    beforeEach(async () => {
      app.auth.activeDevices.add("device-1");
      await send("t1", "u1");
      await claim();
    });

    it("R5-03: refuses an answer signed by a device the account revoked, writing nothing", async () => {
      await ask("presence");
      app.auth.activeDevices.delete("device-1");
      const refused = await answer("a1", signature("webauthn", "user"));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: "forbidden" } });
      expect(await answers()).toEqual([]);
      app.auth.activeDevices.add("device-1");
      expect((await answer("a2", signature("webauthn", "user"))).status).toBe(200);
    });

    it("takes another answer once the host rejected the one before it", async () => {
      await ask();
      expect((await answer("a1")).status).toBe(200);
      expect((await answer("a2")).status).toBe(400);
      await app.action("alice-host", "hostAppend", {
        turnId: "u1",
        items: [
          {
            id: "u1.2",
            kind: "event",
            body: { event: "answer_rejected", itemId: "a1" },
          },
        ],
      });
      expect((await answer("a2")).status).toBe(200);
      expect((await answer("a3")).status).toBe(400);
      expect(await answers()).toEqual([{ id: "a1" }, { id: "a2" }]);
    });

    it("refuses an answer to a question that is answered on the computer, writing nothing", async () => {
      await ask("computer");
      const refused = await answer("a1", signature("webauthn", "user"));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: "forbidden" } });
      expect(await answers()).toEqual([]);
    });

    it("refuses an answer to a presence question unless it carries a presence signature", async () => {
      await ask("presence");
      expect((await answer("a1")).status).toBe(403);
      expect((await answer("a2", signature("es256-raw", "none"))).status).toBe(403);
      expect((await answer("a3", signature("webauthn", "none"))).status).toBe(403);
      expect(await answers()).toEqual([]);
      expect((await answer("a4", signature("webauthn", "user"))).status).toBe(200);
      expect(await answers()).toEqual([{ id: "a4" }]);
    });

    it("T6-06: admits a native presence signature, which carries es256-raw", async () => {
      await ask("presence");
      expect((await answer("a1", signature("es256-raw", "none"))).status).toBe(403);
      expect((await answer("a2", signature("es256-raw", "user"))).status).toBe(200);
      expect(await answers()).toEqual([{ id: "a2" }]);
    });

    it("T6-06: shows the host the keys of the device that answered, and none of a revoked one", async () => {
      await ask("presence");
      expect((await answer("a1", signature("es256-raw", "user"))).status).toBe(200);
      const signals = async () =>
        data(
          await app.action("alice-host", "hostSignals", {
            turns: [{ turnId: "u1", afterSeq: 0 }],
          }),
        );
      expect(await signals()).toMatchObject([
        {
          turnId: "u1",
          items: [{ id: "a1", kind: "answer" }],
          devices: [
            {
              id: "device-1",
              name: "Alice's Mac",
              platform: "web",
              signingKey: { kty: "EC", crv: "P-256" },
            },
          ],
        },
      ]);
      app.auth.activeDevices.delete("device-1");
      const [revoked] = (await signals()) as { devices?: unknown }[];
      expect(revoked).not.toHaveProperty("devices");
    });

    it("admits one of two answers sent at once", async () => {
      await ask();
      const replies = await Promise.all([answer("a1"), answer("a2")]);
      expect(replies.map((answered) => answered.status).sort()).toEqual([200, 400]);
      expect(await answers()).toHaveLength(1);
    });
  });

  it("fails a turn whose host stopped renewing its lease and moves on", async () => {
    await app.server.close();
    app = serveChat(handle, { chat: { leaseMs: 1, maxQueued: 4 } });
    await resetDatabase(handle);
    await app.action("alice-host", "hostHello", HELLO);
    await send("t1", "u1");
    await send("t1", "u2");
    expect(data(await claim())).toMatchObject({ turnId: "u1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(data(await claim())).toMatchObject({ turnId: "u2" });
    expect(
      await rows(handle, "select id, state, outcome from parlor_chat_turns order by id"),
    ).toEqual([
      { id: "u1", state: "failed", outcome: { state: "failed", reason: "host_lost" } },
      { id: "u2", state: "running", outcome: null },
    ]);
    expect(
      await rows(
        handle,
        "select id, kind, body from parlor_chat_items where kind = 'event'",
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^lost\.[0-9a-f-]{36}$/),
        kind: "event",
        body: { event: "host_lost" },
      },
    ]);
  });

  it("refuses every host action until the computer said hello", async () => {
    const stranger = await app.action("alice-host-2", "hostClaim", {});
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({
      error: { code: "forbidden", message: "Say hello before anything else." },
    });
  });

  it("negotiates the host protocol and welcomes only a compatible computer", async () => {
    const tooNew = await app.action("alice-host-2", "hostHello", {
      ...HELLO,
      protocols: { min: 3, max: 4 },
    });
    expect(data(tooNew)).toEqual({
      id: "pc",
      accepted: false,
      reason: "app_too_old",
      protocols: { min: 2, max: 2 },
    });
    expect((await app.action("alice-host-2", "hostClaim", {})).status).toBe(403);
    const welcome = await app.action("alice-host-2", "hostHello", HELLO);
    expect(data(welcome)).toEqual({
      id: "pc",
      accepted: true,
      protocol: 2,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      userActivity: true,
    });
  });

  it("R5-02: refuses a host that predates device trust, telling it to update, and welcomes a current one", async () => {
    const outdated = await app.action("alice-host-2", "hostHello", {
      ...HELLO,
      protocols: { min: 1, max: 1 },
    });
    expect(data(outdated)).toEqual({
      id: "pc",
      accepted: false,
      reason: "host_too_old",
      protocols: { min: 2, max: 2 },
    });
    expect((await app.action("alice-host-2", "hostClaim", {})).status).toBe(403);
    const current = await app.action("alice-host-2", "hostHello", {
      ...HELLO,
      protocols: { min: 1, max: 2 },
    });
    expect(data(current)).toMatchObject({ accepted: true, protocol: 2 });
  });

  it("R5-08: ends the welcome of a computer whose later hello is refused", async () => {
    const refused = await app.action("alice-host", "hostHello", {
      ...HELLO,
      protocols: { min: 1, max: 1 },
    });
    expect(data(refused)).toMatchObject({ accepted: false, reason: "host_too_old" });
    const claimed = await app.action("alice-host", "hostClaim", {});
    expect(claimed.status).toBe(403);
    expect(claimed.body).toMatchObject({ error: { code: "forbidden" } });
    const report = await app.action("alice-host", "hostReport", {
      online: true,
      agents: [],
    });
    expect(report.status).toBe(403);
    expect(data(await app.action("alice-host", "hostHello", HELLO))).toMatchObject({
      accepted: true,
    });
    expect((await app.action("alice-host", "hostClaim", {})).status).not.toBe(403);
  });

  it("R5-09: refuses and prunes a stored computer below the minimum protocol that skips hello after a restart", async () => {
    await rows(handle, "update parlor_chat_hosts set protocol = 1");
    await app.server.close();
    app = serveChat(handle, { chat: { leaseMs: 60_000, maxQueued: 4 } });
    const claimed = await claim();
    expect(claimed.status).toBe(403);
    expect(claimed.body).toMatchObject({ error: { code: "forbidden" } });
    expect(await rows(handle, "select 1 from parlor_chat_hosts")).toHaveLength(0);
    expect(data(await app.action("alice-host", "hostHello", HELLO))).toMatchObject({
      accepted: true,
    });
    expect((await claim()).status).not.toBe(403);
  });

  it("queues a prompt for an offline computer whose grant holds, up to maxQueued, and hands it over when it returns", async () => {
    await app.action("alice-host", "hostReport", { online: false, agents: [] });
    for (const n of [1, 2, 3, 4]) expect((await send("t1", `u${n}`)).status).toBe(200);
    const fifth = await send("t1", "u5");
    expect(fifth.status).toBe(400);
    expect(fifth.body).toMatchObject({ error: { code: "invalid_input" } });
    expect(data(await app.action("alice", "hosts", {}))).toMatchObject([
      { id: "mac", name: "Alice's Mac", online: false, agents: [] },
    ]);
    await app.action("alice-host", "hostReport", { online: true, agents: [] });
    expect(data(await claim())).toMatchObject({ turnId: "u1" });
  });

  it("refuses a prompt for a computer whose grant is gone, online or not", async () => {
    await app.action("alice-host", "hostReport", { online: false, agents: [] });
    app.auth.revokedGrants.add("g-mac");
    const refused = await send("t1", "u1");
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: { code: "not_found" } });
    expect(await rows(handle, "select 1 from parlor_chat_threads")).toEqual([]);
  });

  it("sends only to a computer of the sender", async () => {
    const stranger = await app.action("bob", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab-1",
      prompt: { text: "hello", agent: agentRef },
    });
    expect(stranger.status).toBe(404);
    expect(await rows(handle, "select 1 from parlor_chat_threads")).toEqual([]);
    void alice;
  });
});
