import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineChatUi } from "../ui.js";
import {
  agentRef,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  serveChat,
} from "./spec-kit.js";

const catalog = defineChatUi({
  Kpi: {
    description: "One number.",
    props: z.object({
      label: z.string(),
      value: z.number(),
      unit: z.string().default(""),
    }),
  },
});

const HELLO = {
  protocols: { min: 2, max: 4 },
  hostVersion: "1.0.0",
  name: "Alice's Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
};

describe.each(drivers)("ui items on $name", (driver) => {
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
    app = serveChat(handle, { chat: { ui: catalog } });
    expect((await app.action("alice-host", "hostHello", HELLO)).status).toBe(200);
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "u1-prompt",
      clientId: "tab-1",
      prompt: { text: "how many?", agent: agentRef },
    });
    await app.action("alice-host", "hostClaim", {});
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const itemsOf = async () =>
    (
      data(await app.action("alice", "open", { threadId: "t1" })) as {
        page: { items: { id: string; kind: string; body: unknown }[] };
      }
    ).page.items.map(({ id, kind, body }) => ({ id, kind, body }));

  it("keeps what the agent showed, its props parsed, where the host put it", async () => {
    const appended = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [
        { id: "u1.1", kind: "reply", body: { text: "Here:" } },
        {
          id: "u1.2",
          kind: "ui",
          body: {
            spec: {
              root: "k",
              elements: { k: { type: "Kpi", props: { label: "Visitors", value: 3 } } },
            },
          },
        },
      ],
    });
    expect(appended.status).toBe(200);
    expect((await itemsOf()).slice(1)).toEqual([
      { id: "u1.1", kind: "reply", body: { text: "Here:" } },
      {
        id: "u1.2",
        kind: "ui",
        body: {
          spec: {
            root: "k",
            elements: {
              k: { type: "Kpi", props: { label: "Visitors", value: 3, unit: "" } },
            },
          },
        },
      },
    ]);
  });

  it("keeps a spec the catalog does not match as a failed chat_show step", async () => {
    await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [
        {
          id: "u1.1",
          kind: "ui",
          body: { spec: { root: "k", elements: { k: { type: "Pie" } } } },
        },
      ],
    });
    expect((await itemsOf()).slice(1)).toEqual([
      {
        id: "u1.1",
        kind: "tool",
        body: {
          title: "chat_show",
          tool: { kind: "app", name: "chat_show" },
          status: "failed",
        },
      },
    ]);
  });

  it("refuses a ui item that is not a spec at all", async () => {
    const appended = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [{ id: "u1.1", kind: "ui", body: { spec: "a chart" } }],
    });
    expect(appended.status).toBe(400);
  });
});
