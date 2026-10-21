import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

const hello = (name: string) => ({
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name,
  platform: "darwin",
  agents: [],
});

describe.each(drivers)("the rows of computers whose grant is gone on $name", (driver) => {
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
    await app.action("alice-host-2", "hostHello", hello("Alice's PC"));
    await app.action("bob-host", "hostHello", hello("Bob's Mac"));
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const remaining = () => rows(handle, "select id from parlor_chat_hosts order by id");

  it("are deleted when the sidebar next lists computers", async () => {
    app.auth.revokedGrants.add("g-mac");

    await app.action("alice", "open", {});

    expect(await remaining()).toEqual([{ id: "bob-mac" }, { id: "pc" }]);
  });

  it("are deleted by the computers list too", async () => {
    app.auth.revokedGrants.add("g-pc");

    await app.action("alice", "hosts", {});

    expect(await remaining()).toEqual([{ id: "bob-mac" }, { id: "mac" }]);
  });

  it("are deleted when a prompt is sent to a revoked computer", async () => {
    app.auth.revokedGrants.add("g-mac");

    const reply = await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab-1",
      prompt: { text: "hi", agent: agentRef },
    });

    expect(reply.status).toBe(404);
    expect(await remaining()).toEqual([{ id: "bob-mac" }, { id: "pc" }]);
  });

  it("never take another user's computers with them", async () => {
    app.auth.revokedGrants.add("g-bob");

    await app.action("alice", "hosts", {});

    expect(await remaining()).toEqual([{ id: "bob-mac" }, { id: "mac" }, { id: "pc" }]);
  });

  it("leave every row alone while every grant holds", async () => {
    await app.action("alice", "open", {});

    expect(await remaining()).toEqual([{ id: "bob-mac" }, { id: "mac" }, { id: "pc" }]);
  });
});
