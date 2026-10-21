import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HostStreamBatch } from "../protocol.js";
import { inProcessRelay, type LiveRelay } from "./live.js";
import { MAX_STREAM_BODY_BYTES } from "./routes.js";
import {
  agentRef,
  type ChatServer,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";
import type { TurnHolder } from "./store.js";

const hello = (name: string) => ({
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name,
  platform: "darwin",
  agents: [],
});

describe("the host-only routes", () => {
  let handle: DatabaseHandle;
  let app: ChatServer;
  let accepted: { holder: TurnHolder; batch: HostStreamBatch }[];

  beforeAll(async () => {
    handle = await openDatabase({ name: "pglite" });
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    accepted = [];
    const relay = (): LiveRelay => {
      const real = inProcessRelay();
      return {
        ...real,
        accept(holder, batch) {
          accepted.push({ holder, batch });
          real.accept(holder, batch);
        },
      };
    };
    app = serveChat(handle, { chat: { relay } });
    await app.action("alice-host", "hostHello", hello("Alice's Mac"));
    await app.action("bob-host", "hostHello", hello("Bob's Mac"));
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: "hi", agent: agentRef },
    });
    await app.action("alice-host", "hostClaim", {});
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const delta = (offset: number, text: string) => ({
    type: "delta",
    itemId: "u1.1",
    kind: "reply",
    offset,
    text,
  });

  it("hands a turn's frames to the relay with the turn's holder", async () => {
    const reply = await app.post("alice-host", "stream", {
      turnId: "u1",
      frames: [delta(0, "Hel")],
    });
    expect(reply.status).toBe(204);
    expect(accepted).toEqual([
      {
        holder: {
          owner: { scope: "alice", userId: "alice" },
          threadId: "t1",
          hostId: "mac",
        },
        batch: { turnId: "u1", frames: [delta(0, "Hel")] },
      },
    ]);
  });

  it("refuses another computer's turn and an unknown turn with the same 403", async () => {
    const batch = (turnId: string) => ({ turnId, frames: [delta(0, "x")] });
    const stolen = await app.post("bob-host", "stream", batch("u1"));
    const unknown = await app.post("bob-host", "stream", batch("u-nobody"));
    const sibling = await app.post("alice-host-2", "stream", batch("u1"));
    expect(stolen.status).toBe(403);
    expect(stolen.text).toBe(unknown.text);
    expect(sibling.status).toBe(403);
    expect(accepted).toEqual([]);
  });

  it("refuses a batch for a turn that waits in the queue", async () => {
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u2",
      itemId: "p2",
      clientId: "tab",
      prompt: { text: "and then", agent: agentRef },
    });
    const reply = await app.post("alice-host", "stream", {
      turnId: "u2",
      frames: [delta(0, "x")],
    });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({
      error: { code: "forbidden", message: "The turn is not running." },
    });
    expect(accepted).toEqual([]);
  });

  it("refuses a batch over the size limit with 413", async () => {
    const reply = await app.post("alice-host", "stream", {
      turnId: "u1",
      frames: [delta(0, "x".repeat(MAX_STREAM_BODY_BYTES))],
    });
    expect(reply.status).toBe(413);
    expect(reply.body).toEqual({
      error: {
        code: "invalid_input",
        message: "A stream batch is at most 65536 bytes.",
      },
    });
    expect(accepted).toEqual([]);
  });

  it("refuses a malformed batch with 400", async () => {
    const reply = await app.post("alice-host", "stream", {
      turnId: "u1",
      frames: [{ type: "delta", itemId: "u1.1", kind: "tool", offset: 0, text: "" }],
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: { code: "invalid_input" } });
  });

  it.each(["alice", "alice-agent", undefined])(
    "never admits a caller that is not a host (%s)",
    async (token) => {
      const stream = await app.post(token, "stream", { turnId: "u1", frames: [] });
      const heartbeat = await app.post(token, "heartbeat", {});
      expect([stream.status, heartbeat.status]).toEqual(
        token === undefined ? [401, 401] : [403, 403],
      );
      expect(accepted).toEqual([]);
    },
  );

  it("renews a computer's liveness with one update and no sync event", async () => {
    await rows(
      handle,
      "update parlor_chat_hosts set online_until = now() - interval '1 second' where id = 'mac'",
    );
    expect(
      await rows(
        handle,
        "select online_until > now() as online from parlor_chat_hosts where id = 'mac'",
      ),
    ).toEqual([{ online: false }]);
    const events = await rows(handle, "select count(*)::int as n from sync_events");
    const reply = await app.post("alice-host", "heartbeat", {});
    expect(reply.status).toBe(204);
    expect(
      await rows(
        handle,
        "select online_until > now() as online from parlor_chat_hosts where id = 'mac'",
      ),
    ).toEqual([{ online: true }]);
    expect(await rows(handle, "select count(*)::int as n from sync_events")).toEqual(
      events,
    );
    expect(
      await rows(
        handle,
        "select extract(epoch from online_until - now())::int between 55 and 60 as ok from parlor_chat_hosts where id = 'mac'",
      ),
    ).toEqual([{ ok: true }]);
  });
});
