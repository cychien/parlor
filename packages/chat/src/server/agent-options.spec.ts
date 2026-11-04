import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

/** What Claude Code reports once the user has subagents: one value describes itself at length. */
const subagents = {
  id: "agent",
  name: "Agent",
  current: "default",
  values: [
    { id: "default", name: "Default", description: "The agent's own behavior" },
    { id: "web-fetch", name: "web-fetch", description: "Fetches a page. ".repeat(122) },
    ...Array.from({ length: 60 }, (_, at) => ({
      id: `helper-${at}`,
      name: `helper-${at}`,
    })),
  ],
};

describe.each(drivers)("a computer's agent options on $name", (driver) => {
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
  });
  afterEach(async () => {
    await app.server.close();
  });

  it("connect it even when a description is too long or there are too many values, clipped to fit", async () => {
    const hello = await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 3 },
      hostVersion: "1.0.0",
      name: "Alice's Mac",
      platform: "darwin",
      agents: [{ id: "claude", name: "Claude Code", ready: true, options: [subagents] }],
    });
    expect(hello.status).toBe(200);
    const [host] = data(await app.action("alice", "hosts", {})) as {
      agents: { options: { values: { id: string; description?: string }[] }[] }[];
    }[];
    const values = host!.agents[0]!.options[0]!.values;
    expect(values).toHaveLength(50);
    expect(values[1]!.description).toHaveLength(500);
    expect(values[1]!.description!.endsWith("…")).toBe(true);
  });
});
