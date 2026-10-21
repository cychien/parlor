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

const hello = (name: string) => ({
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name,
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
});

const sendTo = (app: ChatServer, hostId: string) =>
  app.action("alice", "send", {
    threadId: "t1",
    turnId: "u1",
    itemId: "u1-prompt",
    clientId: "tab",
    prompt: { text: "hi", agent: { hostId, agentId: "claude" } },
  });

describe.each(drivers)("a computer whose grant was revoked on $name", (driver) => {
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
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const names = (body: unknown) => (body as { name: string }[]).map((host) => host.name);

  it("is offered until the grant is revoked, then in neither hosts nor open", async () => {
    expect(names(data(await app.action("alice", "hosts", {})))).toEqual([
      "Alice's Mac",
      "Alice's PC",
    ]);

    app.auth.revokedGrants.add("g-mac");

    expect(names(data(await app.action("alice", "hosts", {})))).toEqual(["Alice's PC"]);
    const opened = await app.action("alice", "open", {});
    expect(names((data(opened) as { hosts: unknown }).hosts)).toEqual(["Alice's PC"]);
  });

  it("is refused by send as a computer that does not exist", async () => {
    app.auth.revokedGrants.add("g-mac");

    const reply = await sendTo(app, agentRef.hostId);

    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({
      error: { code: "not_found", message: "Computer not found" },
    });
  });

  it("is still sendable to while the grant holds", async () => {
    expect((await sendTo(app, agentRef.hostId)).status).toBe(200);
  });
});
