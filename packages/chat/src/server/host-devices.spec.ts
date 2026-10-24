import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
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
    (await app.action("alice", "hosts", {})).body as { data: { devices?: string[] }[] };

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
});
