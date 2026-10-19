import { sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "./database.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

if (!postgresUrl) {
  console.info(
    "[parlor] node-postgres contract tests skipped: set PARLOR_TEST_DATABASE_URL to run them",
  );
}

const drivers = [
  { name: "PGlite", open: () => createDatabase({ dataDir: "memory://" }) },
  ...(postgresUrl
    ? [{ name: "node-postgres", open: () => createDatabase({ url: postgresUrl }) }]
    : []),
];

const handles: DatabaseHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

async function open(driver: (typeof drivers)[number]) {
  const handle = await driver.open();
  handles.push(handle);
  return handle;
}

const channel = () => `parlor_contract_${crypto.randomUUID().replaceAll("-", "")}`;

function received() {
  const payloads: string[] = [];
  const waiters = new Set<() => void>();
  return {
    payloads,
    handler: (payload: string) => {
      payloads.push(payload);
      for (const wake of waiters) wake();
    },
    async until(count: number) {
      const deadline = Date.now() + 3000;
      while (payloads.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} notifications`);
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
          setTimeout(resolve, 20);
        });
      }
    },
  };
}

describe.each(drivers)("DataProvider contract on $name", (driver) => {
  it("delivers NOTIFY to a listener until it unlistens", async () => {
    const handle = await open(driver);
    const name = channel();
    const inbox = received();
    const unlisten = await handle.listen(name, inbox.handler);
    await handle.db.execute(sql`select pg_notify(${name}, 'one')`);
    await inbox.until(1);
    await unlisten();
    await handle.db.execute(sql`select pg_notify(${name}, 'two')`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inbox.payloads).toEqual(["one"]);
  });

  it("delivers a NOTIFY sent inside a transaction only after it commits", async () => {
    const handle = await open(driver);
    const name = channel();
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle
      .transaction(async (tx) => {
        await tx.execute(sql`select pg_notify(${name}, 'rolled back')`);
        throw new Error("abort");
      })
      .catch(() => {});
    await handle.transaction(async (tx) => {
      await tx.execute(sql`select pg_notify(${name}, 'committed')`);
    });
    await inbox.until(1);
    expect(inbox.payloads).toEqual(["committed"]);
  });
});

describe.runIf(postgresUrl)("node-postgres when the server drops a connection", () => {
  const admin = async (query: string) => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  };

  it("reports a dropped LISTEN connection once instead of crashing", async () => {
    const handle = await open(drivers[1]!);
    const name = channel();
    let lost = 0;
    let reported!: () => void;
    const report = new Promise<void>((resolve) => (reported = resolve));
    await handle.listen(name, () => {}, {
      onLost: () => {
        lost += 1;
        reported();
      },
    });
    await admin(
      `select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN "${name}"'`,
    );
    await Promise.race([report, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lost).toBe(1);
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle.db.execute(sql`select pg_notify(${name}, 'again')`);
    await inbox.until(1);
  });

  it("survives losing its idle pooled connections and serves the next query", async () => {
    const handle = await open(drivers[1]!);
    await handle.db.execute(sql`select 1`);
    await admin(
      "select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and state = 'idle' and datname = current_database()",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await handle.db.execute(sql`select 2 as n`);
    expect(result.rows).toEqual([{ n: 2 }]);
  });
});
