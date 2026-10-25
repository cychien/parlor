import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

describe.each(drivers)("a token for an agent outside any turn on $name", (driver) => {
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

  const hello = () =>
    app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1",
      name: "Mac",
      platform: "macos",
      agents: [],
    });

  it("is minted for a welcomed computer, named for the agent, and short-lived", async () => {
    await hello();
    const minted = await app.action("alice-host", "hostAgentToken", {
      agent: "Claude Code on Mac",
    });
    expect(minted.status).toBe(200);
    expect(minted.body).toMatchObject({ data: { token: "agent.1" } });
    expect(app.auth.agentDelegated).toEqual([
      { hostId: expect.any(String), agent: "Claude Code on Mac", ttlMs: 10 * 60_000 },
    ]);
  });

  it("is refused to a computer that never said hello, and to a person", async () => {
    expect(
      (await app.action("alice-host", "hostAgentToken", { agent: "Claude Code" })).status,
    ).not.toBe(200);
    await hello();
    expect(
      (await app.action("alice", "hostAgentToken", { agent: "Claude Code" })).status,
    ).toBe(403);
    expect(app.auth.agentDelegated).toEqual([]);
  });
});
