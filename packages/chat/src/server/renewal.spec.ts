import type { DatabaseHandle } from "@parlor/data";
import { SYNC_CHANNEL } from "@parlor/sync";
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

describe.each(drivers)("renewing a turn on $name", (driver) => {
  let handle: DatabaseHandle;
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
    app = serveChat({
      read: () => handle.db,
      transaction: (run) => handle.transaction(run),
      listen: (channel, handler, options) => handle.listen(channel, handler, options),
    });
    for (const host of ["alice-host", "alice-host-2"]) {
      await app.action(host, "hostHello", {
        protocols: { min: 2, max: 2 },
        hostVersion: "1",
        name: "Mac",
        platform: "darwin",
        agents: [],
      });
    }
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: "Hello", agent: agentRef },
    });
    await app.action("alice-host", "hostClaim", {});
    payloads = [];
    stopListening = await handle.listen(SYNC_CHANNEL, (payload) =>
      payloads.push(payload),
    );
  }, 60_000);

  afterEach(async () => {
    await stopListening();
    await app.server.close();
  });

  const leaseOf = async () =>
    (
      (await rows(
        handle,
        "select extract(epoch from lease_until) * 1000 as lease from parlor_chat_turns where id = 'u1'",
      )) as { lease: string }[]
    ).map((row) => Number(row.lease))[0]!;

  it("extends the lease and the token on an empty append, writing and announcing nothing", async () => {
    const before = await leaseOf();
    const issued = app.auth.delegated.length;
    const eventsBefore = await rows(handle, "select id from sync_events");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reply = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [],
    });

    expect(reply.status).toBe(200);
    const renewed = data(reply) as { id: string; leaseUntil: number; token: unknown };
    expect(renewed.id).toBe("t1");
    expect(renewed.leaseUntil).toBeGreaterThan(before);
    expect(await leaseOf()).toBe(renewed.leaseUntil);
    expect(app.auth.delegated).toHaveLength(issued + 1);
    expect(renewed.token).toMatchObject({ token: `turn.u1.${issued + 1}` });
    expect(
      await rows(handle, "select id from parlor_chat_items where kind <> 'prompt'"),
    ).toEqual([]);
    expect(await rows(handle, "select last_seq from parlor_chat_threads")).toEqual([
      { last_seq: 1 },
    ]);
    expect(await rows(handle, "select id from sync_events")).toEqual(eventsBefore);
    expect(payloads).toEqual([]);
  });

  it("refuses to renew a turn this computer does not run, or one that ended", async () => {
    const other = await app.action("alice-host-2", "hostAppend", {
      turnId: "u1",
      items: [],
    });
    expect(other.status).toBe(404);

    await app.action("alice-host", "hostFinish", {
      turnId: "u1",
      outcome: { state: "done", stopReason: "end_turn" },
    });
    const ended = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [],
    });
    expect(ended.status).toBe(403);
  });

  it("takes an ask with no approval, which any device answers from the chat", async () => {
    const ask = {
      id: "u1.1",
      kind: "ask",
      body: {
        question: "Run date?",
        choices: [{ id: "allow", label: "Allow", effect: "allow_once" }],
      },
    };
    const reply = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [ask],
    });
    expect(reply.status).toBe(200);
    const items = data(
      await app.action("alice", "items", { threadId: "t1", afterSeq: 0 }),
    ) as { kind: string; body: unknown }[];
    expect(items.find((item) => item.kind === "ask")?.body).toEqual(ask.body);
  });
});
