import { asId } from "@parlor/core";
import type { DatabaseHandle } from "@parlor/data";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";
import { type ChatDb, sqlChatStore } from "./store.js";

const dialect = new PgDialect();
const textOf = (statement: SQL) => dialect.sqlToQuery(statement).sql;

function beforeStatement(
  tx: ChatDb,
  matches: (statement: string) => boolean,
  interloper: (tx: ChatDb) => Promise<void>,
): ChatDb {
  let interloped = false;
  return new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "execute") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (statement: SQL) => {
        if (!interloped && matches(textOf(statement))) {
          interloped = true;
          await interloper(target);
        }
        return target.execute(statement);
      };
    },
  });
}

describe.each(drivers)("cancelling a queued turn on $name", (driver) => {
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
    await app.action("alice-host", "hostHello", {
      protocols: { min: 2, max: 2 },
      hostVersion: "1.0.0",
      name: "Alice's Mac",
      platform: "darwin",
      agents: [],
    });
    await app.action("alice", "send", {
      threadId: "t1",
      turnId: "u1",
      itemId: "p1",
      clientId: "tab-1",
      prompt: { text: "hi", agent: agentRef },
    });
  }, 60_000);

  afterEach(async () => {
    await app.server.close();
  });

  it("does not overwrite a turn the host claimed after the cancel read it queued", async () => {
    await handle.transaction(async (tx) => {
      const racing = beforeStatement(
        tx as ChatDb,
        (statement) => statement.includes("set state = 'cancelled'"),
        async (inner) => {
          await inner.execute(
            sql`update parlor_chat_turns
              set state = 'running', lease_until = now() + interval '1 minute'
              where id = 'u1'`,
          );
        },
      );
      await sqlChatStore.appendUserItems(
        racing,
        { scope: "alice", userId: asId("user", "alice") },
        {
          threadId: asId("thread", "t1"),
          turnId: asId("turn", "u1"),
          items: [{ id: asId("item", "c1"), kind: "cancel", body: {} }],
        },
      );
    });

    expect(await rows(handle, "select state, outcome from parlor_chat_turns")).toEqual([
      { state: "running", outcome: null },
    ]);
    expect(
      await rows(handle, "select id, kind from parlor_chat_items order by seq"),
    ).toEqual([
      { id: "p1", kind: "prompt" },
      { id: "c1", kind: "cancel" },
    ]);
  });

  it("still cancels a turn that stayed queued", async () => {
    const reply = await app.action("alice", "cancel", {
      threadId: "t1",
      turnId: "u1",
      itemId: "c1",
    });
    expect(reply.status).toBe(200);
    expect(await rows(handle, "select state, outcome from parlor_chat_turns")).toEqual([
      { state: "cancelled", outcome: { state: "cancelled" } },
    ]);
  });
});
