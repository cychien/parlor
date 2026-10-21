import { tagsOverlap } from "@parlor/core";
import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CHAT_ACTIVITY_TAG, CHAT_TAG } from "../tags.js";
import {
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

interface PolledEvent {
  readonly tags: string[][];
  readonly source?: string;
}

describe.each(drivers)("the user activity signal on $name", (driver) => {
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
  }, 60_000);
  afterEach(async () => {
    await app.server.close();
  });

  const call = (token: string, clientId: string) =>
    app.server.fetch(
      new Request("http://app.test/_parlor/chat/actions/userActive", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-parlor-client": clientId,
        },
        body: "{}",
      }),
    );

  const polled = async (token: string): Promise<PolledEvent[]> => {
    const response = await app.server.fetch(
      new Request("http://app.test/_parlor/sync?since=", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    return ((await response.json()) as { events: PolledEvent[] }).events;
  };

  it("T7-05 (a) announces a bare activity event the calling tab's client id marks as its own", async () => {
    const reply = await call("alice", "tab-1");
    expect(reply.status).toBe(200);

    expect(await polled("alice")).toMatchObject([
      { tags: [[CHAT_ACTIVITY_TAG]], source: "tab-1" },
    ]);
    expect(await polled("alice-host")).toMatchObject([
      { tags: [[CHAT_ACTIVITY_TAG]], source: "tab-1" },
    ]);
  });

  it("T7-05 (b) refuses a host and an agent, and announces nothing for them", async () => {
    expect((await call("alice-host", "h")).status).toBe(403);
    expect((await call("alice-agent", "a")).status).toBe(403);
    expect(await polled("alice")).toEqual([]);
  });

  it("T7-05 (c) shares no tag prefix with the chat tag a claim loop wakes on", () => {
    expect(tagsOverlap([CHAT_ACTIVITY_TAG], [CHAT_TAG])).toBe(false);
    expect(tagsOverlap([CHAT_ACTIVITY_TAG], [CHAT_TAG, "t1"])).toBe(false);
  });

  it("tells a host in the welcome that this server sends user activity", async () => {
    const reply = await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1.0.0",
      name: "Mac",
      platform: "darwin",
      agents: [],
    });
    expect(data(reply)).toMatchObject({ accepted: true, userActivity: true });
  });
});
