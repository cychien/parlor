import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

describe.each(drivers)("the devices a computer runs prompts from on $name", (driver) => {
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

  const hosts = async () =>
    (await app.action("alice", "hosts", {})).body as {
      data: { devices?: string[]; presenceDue?: Record<string, number> }[];
    };

  it("are absent until the computer reports them, then listed, and kept by a report that omits them", async () => {
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1",
      name: "Mac",
      platform: "macos",
      agents: [],
    });
    expect((await hosts()).data[0]).not.toHaveProperty("devices");
    await app.action("alice-host", "hostReport", {
      online: true,
      agents: [],
      devices: ["device-laptop", "device-phone"],
    });
    expect((await hosts()).data[0]?.devices).toEqual(["device-laptop", "device-phone"]);
    await app.action("alice-host", "hostReport", { online: true, agents: [] });
    expect((await hosts()).data[0]?.devices).toEqual(["device-laptop", "device-phone"]);
    await app.action("alice-host", "hostReport", {
      online: true,
      agents: [],
      devices: [],
    });
    expect((await hosts()).data[0]?.devices).toEqual([]);
  });

  it("say when the computer last looked for its agents, after a tab asked, and keep it through other reports", async () => {
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 3 },
      hostVersion: "1",
      name: "Mac",
      platform: "macos",
      agents: [],
    });
    const checkedAt = async () =>
      (
        (await app.action("alice", "hosts", {})).body as {
          data: { agentsCheckedAt?: number }[];
        }
      ).data[0]?.agentsCheckedAt;
    expect(await checkedAt()).toBeUndefined();

    const asked = await app.action("alice", "checkAgents", {});
    expect(asked.status).toBe(200);
    const { askedAt } = (asked.body as { data: { askedAt: number } }).data;
    const events = await rows(
      handle,
      "select tags from sync_events order by version desc limit 1",
    );
    expect(events).toEqual([{ tags: [["parlor_chat_agents_check"]] }]);

    await app.action("alice-host", "hostReport", {
      online: true,
      agents: [{ id: "claude", name: "Claude Code", ready: true }],
      agentsChecked: true,
    });
    const reported = await checkedAt();
    expect(reported).toBeGreaterThanOrEqual(askedAt);
    await app.action("alice-host", "hostReport", { online: true, agents: [] });
    expect(await checkedAt()).toBe(reported);
  });

  it("carry when each device must confirm with Face ID or Touch ID again, kept by a report that omits it", async () => {
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1",
      name: "Mac",
      platform: "macos",
      agents: [],
    });
    expect((await hosts()).data[0]).not.toHaveProperty("presenceDue");
    await app.action("alice-host", "hostReport", {
      online: true,
      agents: [],
      devices: ["device-laptop", "device-phone"],
      presenceDue: { "device-phone": 1_800_000_000_000 },
    });
    expect((await hosts()).data[0]?.presenceDue).toEqual({
      "device-phone": 1_800_000_000_000,
    });
    await app.action("alice-host", "hostReport", { online: true, agents: [] });
    expect((await hosts()).data[0]?.presenceDue).toEqual({
      "device-phone": 1_800_000_000_000,
    });
    await app.action("alice-host", "hostReport", {
      online: true,
      agents: [],
      presenceDue: {},
    });
    expect((await hosts()).data[0]?.presenceDue).toEqual({});
  });
});
