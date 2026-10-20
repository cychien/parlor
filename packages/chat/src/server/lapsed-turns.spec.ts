import type { DatabaseHandle } from "@parlor/data";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

const HELLO = {
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name: "Alice's Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
};
const LONG_TURN_ID = "u".repeat(64);

describe.each(drivers)("a turn whose lease lapsed on $name", (driver) => {
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
    await app.action("alice-host", "hostHello", HELLO);
    await app.action("alice-host-2", "hostHello", { ...HELLO, name: "Alice's PC" });
  }, 60_000);

  afterEach(async () => {
    vi.useRealTimers();
    await app.server.close();
  });

  const send = (threadId: string, turnId: string, itemId = `${turnId}-p`) =>
    app.action("alice", "send", {
      threadId,
      turnId,
      itemId,
      clientId: "tab-1",
      prompt: { text: "hi", agent: agentRef },
    });

  const lapse = (turnId: string) =>
    rows(
      handle,
      `update parlor_chat_turns set lease_until = now() - interval '1 second' where id = '${turnId}'`,
    );

  const turnStates = () =>
    rows(handle, "select id, state from parlor_chat_turns order by id");

  const syncTags = async () =>
    (await rows(handle, "select tags from sync_events order by version")).map(
      (row) => (row as { tags: unknown }).tags,
    );

  const lostEvents = () =>
    rows(handle, "select id, turn_id from parlor_chat_items where kind = 'event'");

  describe("a derived item id", () => {
    it("fits the item id limit when the turn id is 64 characters", async () => {
      await send("t1", LONG_TURN_ID, "p1");
      await app.action("alice-host", "hostClaim", {});
      await lapse(LONG_TURN_ID);

      expect((await app.action("alice-host", "hostClaim", {})).status).toBe(404);

      const [lost] = (await lostEvents()) as { id: string; turn_id: string }[];
      expect(lost?.turn_id).toBe(LONG_TURN_ID);
      expect(lost?.id).toMatch(/^lost\.[0-9a-f-]{36}$/);
      const opened = await app.action("alice", "open", { threadId: "t1" });
      expect(opened.status).toBe(200);
      const items = (data(opened) as { page: { items: { kind: string }[] } }).page.items;
      expect(items.map((item) => item.kind)).toEqual(["prompt", "event"]);
    });
  });

  describe("a host operation on it", () => {
    beforeEach(async () => {
      await send("t1", "u1");
      await app.action("alice-host", "hostClaim", {});
      await lapse("u1");
    });

    it("cannot append items and so cannot revive the turn", async () => {
      const reply = await app.action("alice-host", "hostAppend", {
        turnId: "u1",
        items: [{ id: "u1.1", kind: "reply", body: { text: "late" } }],
      });
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({
        error: { code: "forbidden", message: "The turn is not running." },
      });
      expect(await rows(handle, "select id from parlor_chat_items order by seq")).toEqual(
        [{ id: "u1-p" }],
      );
    });

    it("cannot finish it", async () => {
      const reply = await app.action("alice-host", "hostFinish", {
        turnId: "u1",
        outcome: { state: "done", stopReason: "end_turn" },
      });
      expect(reply.status).toBe(403);
      expect(await turnStates()).toEqual([{ id: "u1", state: "running" }]);
    });

    it("cannot stream to it", async () => {
      const reply = await app.post("alice-host", "stream", {
        turnId: "u1",
        frames: [{ type: "delta", itemId: "u1.1", kind: "reply", offset: 0, text: "x" }],
      });
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({
        error: { code: "forbidden", message: "The turn is not running." },
      });
    });
  });

  describe("the stream route", () => {
    const batch = (turnId: string) => ({
      turnId,
      frames: [
        { type: "delta", itemId: `${turnId}.1`, kind: "reply", offset: 0, text: "x" },
      ],
    });

    it("checks the turn's state on every batch instead of remembering a first answer", async () => {
      await send("t1", "u1");
      await send("t1", "u2");
      expect((await app.post("alice-host", "stream", batch("u2"))).status).toBe(403);
      await app.action("alice-host", "hostClaim", {});
      expect((await app.post("alice-host", "stream", batch("u1"))).status).toBe(204);

      await app.action("alice-host", "hostFinish", {
        turnId: "u1",
        outcome: { state: "done", stopReason: "end_turn" },
      });

      const late = await app.post("alice-host", "stream", batch("u1"));
      expect(late.status).toBe(403);
      expect(late.body).toEqual({
        error: { code: "forbidden", message: "The turn is not running." },
      });
    });
  });

  describe("reconciliation", () => {
    beforeEach(async () => {
      await send("t1", "u1");
      await app.action("alice-host", "hostClaim", {});
      await lapse("u1");
    });

    const failed = [{ id: "u1", state: "failed" }];

    it("commits when the claim that triggered it finds nothing to claim", async () => {
      const claim = await app.action("alice-host", "hostClaim", {});
      expect(claim.status).toBe(404);
      expect(await turnStates()).toEqual(failed);
      expect(await lostEvents()).toHaveLength(1);
    });

    it("tells the sync stream which thread changed", async () => {
      const before = (await syncTags()).length;
      await app.action("alice-host", "hostClaim", {});
      expect((await syncTags()).slice(before)).toEqual([[["parlor_chat", "t1"]]]);
    });

    it("runs off another computer's heartbeat", async () => {
      expect((await app.post("alice-host-2", "heartbeat", {})).status).toBe(204);
      expect(await turnStates()).toEqual(failed);
      expect(await lostEvents()).toHaveLength(1);
    });

    it("runs off the computer's own heartbeat", async () => {
      expect((await app.post("alice-host", "heartbeat", {})).status).toBe(204);
      expect(await turnStates()).toEqual(failed);
    });

    it("leaves another user's turns alone on a heartbeat", async () => {
      await app.action("bob-host", "hostHello", { ...HELLO, name: "Bob's Mac" });
      expect((await app.post("bob-host", "heartbeat", {})).status).toBe(204);
      expect(await turnStates()).toEqual([{ id: "u1", state: "running" }]);
    });

    it("runs on a timer, so a lone crashed computer's turn still ends", async () => {
      await app.server.close();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      app = serveChat(handle);
      await app.action("alice", "hosts", {});
      expect(await turnStates()).toEqual([{ id: "u1", state: "running" }]);

      await vi.advanceTimersByTimeAsync(30_000);

      await vi.waitFor(async () => expect(await turnStates()).toEqual(failed));
      expect(await syncTags()).toContainEqual([["parlor_chat", "t1"]]);
    });
  });

  describe("a computer that stopped sending heartbeats", () => {
    const age = () =>
      rows(
        handle,
        "update parlor_chat_hosts set online_until = now() - interval '1 second' where id = 'mac'",
      );
    const hostTags = async () =>
      (await syncTags()).filter((tags) =>
        JSON.stringify(tags).includes("parlor_chat_hosts"),
      );

    it("is announced offline once, and announced again when it returns", async () => {
      const announced = (await hostTags()).length;
      await age();

      await app.post("alice-host-2", "heartbeat", {});
      await app.post("alice-host-2", "heartbeat", {});
      expect((await hostTags()).slice(announced)).toEqual([
        [["parlor_chat_hosts", "mac"]],
      ]);
      const listed = data(await app.action("alice", "hosts", {})) as {
        id: string;
        online: boolean;
      }[];
      expect(listed.map(({ id, online }) => [id, online])).toEqual([
        ["mac", false],
        ["pc", true],
      ]);

      await app.post("alice-host", "heartbeat", {});
      await app.post("alice-host", "heartbeat", {});
      expect((await hostTags()).slice(announced)).toEqual([
        [["parlor_chat_hosts", "mac"]],
        [["parlor_chat_hosts", "mac"]],
      ]);
    });
  });
});
