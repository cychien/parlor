import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./create-server.js";
import type { PluginHost, ServerPlugin } from "./plugin.js";

let database: DatabaseHandle;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
});

afterAll(async () => {
  await database.close();
});

describe("PluginHost.ready", () => {
  it("resolves once the plugins' migrations are applied, before any request", async () => {
    let seen: PluginHost | undefined;
    const plugin: ServerPlugin = {
      name: "late",
      migrations: [
        { id: "late/0001_items", sql: "create table parlor_late_items (id int)" },
      ],
      setup(host) {
        seen = host;
        return {};
      },
    };
    const server = createServer({
      actions: createRegistry({}),
      database: {
        read: () => database.read(),
        transaction: (run) => database.transaction(run),
      },
      plugins: [plugin],
    });

    await seen?.ready?.();

    const tables = (await database.db.execute(
      sql`select tablename from pg_tables where tablename = 'parlor_late_items'`,
    )) as { rows: unknown[] };
    expect(tables.rows).toEqual([{ tablename: "parlor_late_items" }]);
    await server.close();
  });
});
