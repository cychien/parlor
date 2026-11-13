import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

const HELLO = {
  protocols: { min: 2, max: 5 },
  hostVersion: "1.0.0",
  name: "Alice's Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
};

describe.each(drivers)("steering a queued prompt on $name", (driver) => {
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
    app = serveChat(handle, { chat: {} });
    expect((await app.action("alice-host", "hostHello", HELLO)).status).toBe(200);
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const send = (turnId: string, text: string) =>
    app.action("alice", "send", {
      threadId: "t1",
      turnId,
      itemId: `${turnId}-prompt`,
      clientId: "tab-1",
      prompt: { text, agent: agentRef },
    });

  const signals = async () =>
    data(
      await app.action("alice-host", "hostSignals", {
        turns: [{ turnId: "u1", afterSeq: 0 }],
      }),
    ) as {
      turnId: string;
      queued?: { id: string; body: { text: string } }[];
    }[];

  const opened = async () =>
    data(await app.action("alice", "open", { threadId: "t1" })) as {
      page: {
        items: { id: string; turnId: string }[];
        turns: { turnId: string; state: string; steeredAfter?: string }[];
      };
    };

  it("hands the running turn the prompts queued behind it, and folds one in after the item it names", async () => {
    await send("u1", "compare last week");
    await app.action("alice-host", "hostClaim", {});
    await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [{ id: "u1.1", kind: "reply", body: { text: "Looking." } }],
    });
    await send("u2", "only Paid Social");

    expect(
      (await signals()).map((batch) => [
        batch.turnId,
        batch.queued?.map((item) => item.body.text),
      ]),
    ).toEqual([["u1", ["only Paid Social"]]]);

    expect(
      data(
        await app.action("alice-host", "hostSteer", {
          turnId: "u1",
          steered: "u2",
          after: "u1.1",
        }),
      ),
    ).toEqual({ steered: true });

    const { page } = await opened();
    expect(page.turns.find((turn) => turn.turnId === "u2")).toEqual({
      turnId: "u2",
      state: "done",
      agent: agentRef,
      steeredAfter: "u1.1",
    });
    expect(await signals()).toEqual([]);
    expect((await app.action("alice-host", "hostClaim", {})).status).toBe(404);
  });

  it("steers nothing that is no longer queued", async () => {
    await send("u1", "compare last week");
    await app.action("alice-host", "hostClaim", {});
    await send("u2", "only Paid Social");
    await app.action("alice", "cancel", {
      threadId: "t1",
      turnId: "u2",
      itemId: "u2-cancel",
    });
    expect(
      data(await app.action("alice-host", "hostSteer", { turnId: "u1", steered: "u2" })),
    ).toEqual({
      steered: false,
    });
  });
});
