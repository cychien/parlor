import { is, sql } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ConnectionOwner,
  createConnectionScope,
  TopicChannels,
} from "./connection-scope.js";
import { createDatabase, type DatabaseHandle } from "./database.js";

function tracked(name: string, log: string[]) {
  return { name, close: async () => void log.push(`closed ${name}`) };
}

describe("ConnectionOwner", () => {
  it("opens one set of connections per key and closes them all once", async () => {
    const owner = new ConnectionOwner();
    const log: string[] = [];
    const a = {};
    const b = {};
    const first = owner.connectionsFor(a, () => tracked("a", log));
    expect(owner.connectionsFor(a, () => tracked("again", log))).toBe(first);
    owner.connectionsFor(b, () => tracked("b", log));
    await owner.close();
    expect(log.sort()).toEqual(["closed a", "closed b"]);
    expect(() => owner.connectionsFor(a, () => tracked("late", log))).toThrow(/closed/);
  });
});

describe("createConnectionScope", () => {
  it("runs synchronously and returns the callback's value", () => {
    const scope = createConnectionScope();
    expect(scope.run(() => 42)).toBe(42);
  });

  let pglite: DatabaseHandle;

  // PGlite starts on its first query and that is the slow part, so it happens once, outside any test's timeout.
  beforeAll(async () => {
    pglite = await createDatabase({ dataDir: "memory://" });
    await pglite.db.execute(sql`select 1`);
  }, 30_000);

  afterAll(async () => {
    await pglite.close();
  });

  it("leaves PGlite untouched", async () => {
    const scope = createConnectionScope();
    try {
      const result = await scope.run(() => pglite.db.execute(sql`select 1 as n`));
      expect(result.rows).toEqual([{ n: 1 }]);
    } finally {
      await scope.close();
    }
  });
});

describe("a node-postgres handle's db", () => {
  it("is still a Drizzle Postgres database to code that checks", async () => {
    const handle = await createDatabase({ url: "postgres://nobody@127.0.0.1:1/none" });
    try {
      expect(is(handle.db, PgDatabase)).toBe(true);
      expect(typeof handle.db.select).toBe("function");
      expect("transaction" in handle.db).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

describe("a topic's subscription on the bus", () => {
  it("ends subscribed when a listener comes back while the bus is still leaving", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    let leaving: () => void = () => {};
    const leavingStarted = new Promise<void>((resolve) => (leaving = resolve));
    const topics = new TopicChannels({
      publish: async () => {},
      subscribe: async (_channel, topic) => {
        calls.push(`+${topic}`);
      },
      unsubscribe: async (_channel, topic) => {
        leaving();
        await slow;
        calls.push(`-${topic}`);
      },
    });
    const leave = await topics.listen("sync", "org-1", () => {});
    const left = leave();
    await leavingStarted;
    const back = topics.listen("sync", "org-1", () => {});
    release();
    await Promise.all([left, back]);
    expect(calls).toEqual(["+org-1", "-org-1", "+org-1"]);
    expect(topics.deliver("sync", "org-1", "x")).toBe(true);
  });

  it("tells the bus nothing for a second listener of a topic it already hears", async () => {
    const calls: string[] = [];
    const topics = new TopicChannels({
      publish: async () => {},
      subscribe: async (_channel, topic) => void calls.push(`+${topic}`),
      unsubscribe: async (_channel, topic) => void calls.push(`-${topic}`),
    });
    const first = await topics.listen("sync", "org-1", () => {});
    const second = await topics.listen("sync", "org-1", () => {});
    await first();
    expect(calls).toEqual(["+org-1"]);
    await second();
    expect(calls).toEqual(["+org-1", "-org-1"]);
  });

  it("tells the bus nothing when a listener leaves and another comes back before it was told", async () => {
    const calls: string[] = [];
    const topics = new TopicChannels({
      publish: async () => {},
      subscribe: async (_channel, topic) => void calls.push(`+${topic}`),
      unsubscribe: async (_channel, topic) => void calls.push(`-${topic}`),
    });
    const leave = await topics.listen("sync", "org-1", () => {});
    await Promise.all([leave(), topics.listen("sync", "org-1", () => {})]);
    expect(calls).toEqual(["+org-1"]);
  });

  it("leaves a topic the bus still sends it, even one it never subscribed in this life", async () => {
    const calls: string[] = [];
    const scope = createConnectionScope({
      bus: {
        publish: async () => {},
        subscribe: async (_channel, topic) => void calls.push(`+${topic}`),
        unsubscribe: async (_channel, topic) => void calls.push(`-${topic}`),
      },
    });
    expect(scope.deliver("sync", "org-1", "x")).toBe(false);
    await vi.waitFor(() => expect(calls).toEqual(["-org-1"]));
    await scope.close();
  });

  it("forgets a listener whose subscription the bus refused", async () => {
    let refuse = true;
    const calls: string[] = [];
    const topics = new TopicChannels({
      publish: async () => {},
      subscribe: async (_channel, topic) => {
        if (refuse) throw new Error("bus away");
        calls.push(`+${topic}`);
      },
      unsubscribe: async (_channel, topic) => void calls.push(`-${topic}`),
    });
    await expect(topics.listen("sync", "org-1", () => {})).rejects.toThrow("bus away");
    expect(topics.deliver("sync", "org-1", "x")).toBe(false);
    refuse = false;
    const leave = await topics.listen("sync", "org-1", () => {});
    await leave();
    expect(calls).toEqual(["+org-1", "-org-1"]);
  });
});
