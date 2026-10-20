import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

describe.each(drivers)("the agent a turn token names on $name", (driver) => {
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
    app = serveChat({
      read: () => handle.db,
      transaction: (run) => handle.transaction(run),
    });
  });
  afterEach(async () => {
    await app.server.close();
  });

  it("is the name the computer reported for the profile, as audit records and cards show it", async () => {
    await app.action("alice-host", "hostHello", {
      protocols: { min: 1, max: 1 },
      hostVersion: "1",
      name: "Mac",
      platform: "macos",
      agents: [],
    });
    await app.action("alice-host", "hostReport", {
      online: true,
      agents: [{ id: "claude", name: "Claude Code", ready: true }],
    });
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: "Hello", agent: agentRef },
    });
    expect((await app.action("alice-host", "hostClaim", {})).status).toBe(200);
    await app.action("alice-host", "hostAppend", { turnId: "u1", items: [] });
    expect(app.auth.delegated.map((turn) => turn.agent)).toEqual([
      "Claude Code",
      "Claude Code",
    ]);
  });

  it("finds the name in the store after a restart forgot it", async () => {
    await app.action("alice-host", "hostHello", {
      protocols: { min: 1, max: 1 },
      hostVersion: "1",
      name: "Mac",
      platform: "macos",
      agents: [{ id: "claude", name: "Claude Code", ready: true }],
    });
    await app.server.close();
    app = serveChat({
      read: () => handle.db,
      transaction: (run) => handle.transaction(run),
    });
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: "Hello", agent: agentRef },
    });
    await app.action("alice-host", "hostClaim", {});
    expect(app.auth.delegated.map((turn) => turn.agent)).toEqual(["Claude Code"]);
  });
});
