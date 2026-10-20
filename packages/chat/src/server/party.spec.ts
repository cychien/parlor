import { asId, DEV_USER_ID, type Principal } from "@parlor/core";
import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { partyOf } from "./party.js";
import {
  agentRef,
  type ChatServer,
  data,
  openDatabase,
  resetDatabase,
  serveChat,
  TOKENS,
} from "./spec-kit.js";

const principal = (token: string): Principal => {
  const found = TOKENS[token];
  if (!found) throw new Error(`no token ${token}`);
  return found;
};
const anonymous: Principal = { kind: "anonymous" };

describe("partyOf", () => {
  it("resolves a signed-in user with the device of its session", () => {
    expect(partyOf("user", principal("alice"), "acme", true)).toEqual({
      scope: "acme",
      userId: "alice",
      deviceId: undefined,
    });
    const phone: Principal = {
      kind: "user",
      userId: asId("user", "alice"),
      sessionId: "s",
      deviceId: asId("device", "phone"),
    };
    expect(partyOf("user", phone, "acme", true)).toMatchObject({ deviceId: "phone" });
  });

  it("resolves a host with its principal and its user as the owner", () => {
    expect(partyOf("host", principal("alice-host"), "alice", true)).toEqual({
      scope: "alice",
      userId: "alice",
      host: principal("alice-host"),
    });
  });

  it("lets an anonymous caller act as the dev user only without an enforcing provider", () => {
    expect(partyOf("user", anonymous, "default", false)).toEqual({
      scope: "default",
      userId: DEV_USER_ID,
      deviceId: undefined,
    });
    expect(() => partyOf("user", anonymous, "default", true)).toThrow("Sign in first.");
    expect(() => partyOf("host", anonymous, "default", false)).toThrow(
      "Only a connected computer can call this.",
    );
  });

  it.each([
    [
      "an agent on a user action",
      "user",
      "alice-agent",
      "A agent principal cannot use the chat.",
    ],
    [
      "a host on a user action",
      "user",
      "alice-host",
      "A host principal cannot use the chat.",
    ],
    [
      "a user on a host action",
      "host",
      "alice",
      "Only a connected computer can call this.",
    ],
  ] as const)("refuses %s", (_name, party, token, message) => {
    expect(() => partyOf(party, principal(token), "alice", true)).toThrow(message);
  });
});

describe("who may call which chat action", () => {
  let handle: DatabaseHandle;
  let app: ChatServer;

  beforeAll(async () => {
    handle = await openDatabase({ name: "pglite" });
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await resetDatabase(handle);
  });
  afterEach(async () => {
    await app.server.close();
  });

  it("refuses an agent on a user action and a user on a host action", async () => {
    app = serveChat(handle);
    const agent = await app.action("alice-agent", "open", {});
    expect(agent.status).toBe(403);
    const user = await app.action("alice", "hostClaim", {});
    expect(user.status).toBe(403);
    const hostOnUser = await app.action("alice-host", "open", {});
    expect(hostOnUser.status).toBe(403);
    const signedOut = await app.action(undefined, "open", {});
    expect(signedOut.status).toBe(401);
  });

  it("acts as the dev user for an anonymous caller when no provider enforces, who owns nothing of Alice", async () => {
    app = serveChat(handle, { enforcing: false });
    expect(data(await app.action(undefined, "hosts", {}))).toEqual([]);
    await app.action("alice-host", "hostHello", {
      protocols: { min: 1, max: 1 },
      hostVersion: "1",
      name: "Mac",
      platform: "darwin",
      agents: [],
    });
    const sent = await app.action(undefined, "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab",
      prompt: { text: "hi", agent: agentRef },
    });
    expect(sent.status).toBe(404);
  });
});
