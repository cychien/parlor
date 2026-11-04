import { userOf } from "@parlor/core";
import type { DatabaseHandle } from "@parlor/data";
import { type ScopeResolver } from "@parlor/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

const ORG_HEADER = "x-org";

/** An app whose users belong to several orgs and pick one per request. */
const orgs: ScopeResolver = (request, principal) => {
  const userId = userOf(principal);
  if (userId === undefined) return "anonymous";
  if (principal.kind === "agent" && principal.turn?.scope) return principal.turn.scope;
  const org = request.headers.get(ORG_HEADER);
  return org ? `org:${org}` : `user:${userId}`;
};

const inOrg = (org: string) => ({ [ORG_HEADER]: org });

const hello = {
  protocols: { min: 2, max: 3 },
  hostVersion: "1.0.0",
  name: "Alice's Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
};

describe.each(drivers)("computers across scopes on $name", (driver) => {
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
    app = serveChat(handle, { scope: orgs });
    expect((await app.action("alice-host", "hostHello", hello)).status).toBe(200);
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  const send = (org: string, threadId: string, turnId: string) =>
    app.action(
      "alice",
      "send",
      {
        threadId,
        turnId,
        itemId: `${turnId}-prompt`,
        clientId: "tab",
        prompt: { text: "hi", agent: { hostId: "mac", agentId: "claude" } },
      },
      inOrg(org),
    );

  it("serves its user in every org they open the sidebar in", async () => {
    for (const org of ["acme", "globex"]) {
      const hosts = data(await app.action("alice", "hosts", {}, inOrg(org)));
      expect(hosts, org).toMatchObject([
        { id: "mac", name: "Alice's Mac", online: true },
      ]);
    }
  });

  it("runs a prompt sent in an org and answers it in that org's thread only", async () => {
    expect((await send("acme", "t-acme", "u1")).status).toBe(200);
    const claimed = await app.action("alice-host", "hostClaim", {});
    expect(claimed.status).toBe(200);
    expect(data(claimed)).toMatchObject({ id: "t-acme", turnId: "u1" });
    expect(app.auth.delegated).toMatchObject([{ turnId: "u1", scope: "org:acme" }]);
    expect(
      (
        await app.action("alice-host", "hostAppend", {
          turnId: "u1",
          items: [{ id: "r1", kind: "reply", body: { text: "hello" } }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.action("alice-host", "hostFinish", {
          turnId: "u1",
          outcome: { state: "done", stopReason: "end_turn" },
        })
      ).status,
    ).toBe(200);
    const acme = data(
      await app.action("alice", "open", { threadId: "t-acme" }, inOrg("acme")),
    ) as {
      threads: { id: string }[];
      page: { items: { kind: string }[]; turns: { state: string }[] };
    };
    expect(acme.threads.map((thread) => thread.id)).toEqual(["t-acme"]);
    expect(acme.page.items.map((item) => item.kind)).toEqual(["prompt", "reply"]);
    expect(acme.page.turns.map((turn) => turn.state)).toEqual(["done"]);
    const globex = data(await app.action("alice", "open", {}, inOrg("globex"))) as {
      threads: unknown[];
    };
    expect(globex.threads).toEqual([]);
  });

  it("wakes the user's computer and tabs in every org through their account stream", async () => {
    await send("acme", "t-acme", "u1");
    await app.action("alice", "userActive", {}, inOrg("globex"));
    await app.action("alice-host", "hostReport", { online: true, agents: hello.agents });
    const streams = (await rows(handle, "select distinct scope from sync_events")) as {
      scope: string;
    }[];
    expect(streams.map((row) => row.scope)).toEqual(["\u001falice"]);
  });
});
