import { is, sql } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConnectionOwner, createConnectionScope } from "./connection-scope.js";
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
