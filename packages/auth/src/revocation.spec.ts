import type { DataProvider, ListenOptions } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { AUTH_MIGRATIONS } from "./migrations.js";
import { REVOCATION_CHANNEL, RevocationSet } from "./revocation.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;
const HORIZON_MS = 10 * 60_000;

const handles = new Map<string, DatabaseHandle>();
const sets: RevocationSet[] = [];
afterEach(async () => {
  for (const set of sets.splice(0)) await set.stop();
});
afterAll(async () => {
  for (const handle of handles.values()) await handle.close();
});

async function openDatabase(url?: string): Promise<DatabaseHandle> {
  const key = url ?? "pglite";
  let handle = handles.get(key);
  if (!handle) {
    handle = await createDatabase(url ? { url } : { dataDir: "memory://" });
    handles.set(key, handle);
  }
  await handle.db.execute(sql`drop table if exists parlor_auth_revocations`);
  for (const migration of AUTH_MIGRATIONS)
    await handle.db.execute(sql.raw(migration.sql));
  return handle;
}

interface Counted extends DataProvider {
  readonly queries: number;
}

function counted(handle: DatabaseHandle, listen = true): Counted {
  let queries = 0;
  return {
    read: () => {
      queries += 1;
      return handle.db;
    },
    transaction: (run) => handle.transaction(run),
    ...(listen
      ? {
          listen: (channel, handler, options) => handle.listen(channel, handler, options),
        }
      : {}),
    get queries() {
      return queries;
    },
  };
}

/** A provider whose LISTEN connection the test can drop, losing every NOTIFY until relisten. */
function droppable(handle: DatabaseHandle) {
  let current: { live: boolean; options: ListenOptions | undefined } | undefined;
  let refuse = 0;
  const provider: DataProvider = {
    read: () => handle.db,
    transaction: (run) => handle.transaction(run),
    listen: async (channel, handler, options) => {
      if (refuse > 0) {
        refuse -= 1;
        throw new Error("connection refused");
      }
      const registration = { live: true, options };
      current = registration;
      const unlisten = await handle.listen(channel, (payload) => {
        if (registration.live) handler(payload);
      });
      return async () => {
        registration.live = false;
        await unlisten();
      };
    },
  };
  return {
    provider,
    refuse(count: number) {
      refuse = count;
    },
    drop(refuseNext = 0) {
      refuse = refuseNext;
      if (!current) throw new Error("nothing listens");
      current.live = false;
      current.options?.onLost?.();
      current = undefined;
    },
  };
}

function track(set: RevocationSet): RevocationSet {
  sets.push(set);
  return set;
}

const revoke = (
  handle: DatabaseHandle,
  kind: "session" | "grant",
  id: string,
  at?: number,
) => handle.transaction((tx) => RevocationSet.revoke(tx, { kind, id }, at));

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const drivers = [
  { name: "PGlite", url: undefined },
  ...(postgresUrl ? [{ name: "node-postgres", url: postgresUrl }] : []),
];

describe.each(drivers)("RevocationSet on $name", ({ url }) => {
  it("loads revocations committed before it started", async () => {
    const handle = await openDatabase(url);
    await revoke(handle, "grant", "g-1");
    const set = track(
      new RevocationSet({ database: counted(handle), horizonMs: HORIZON_MS }),
    );
    await set.ready();
    expect(set.mode).toBe("following");
    expect(await set.isRevoked({ kind: "grant", id: "g-1" })).toBe(true);
  });

  it("answers from memory while following, without a query per call", async () => {
    const handle = await openDatabase(url);
    const database = counted(handle);
    const set = track(new RevocationSet({ database, horizonMs: HORIZON_MS }));
    await set.ready();
    const before = database.queries;
    await revoke(handle, "grant", "g-2");
    await eventually(() => set.isRevoked({ kind: "grant", id: "g-2" }));
    expect(await set.isRevoked({ kind: "grant", id: "other" })).toBe(false);
    expect(database.queries).toBe(before);
  });

  it("checks the table on every call when the provider cannot listen", async () => {
    const handle = await openDatabase(url);
    const database = counted(handle, false);
    const set = track(new RevocationSet({ database, horizonMs: HORIZON_MS }));
    await set.ready();
    expect(set.mode).toBe("checking");
    expect(await set.isRevoked({ kind: "grant", id: "g-3" })).toBe(false);
    await revoke(handle, "grant", "g-3");
    expect(await set.isRevoked({ kind: "grant", id: "g-3" })).toBe(true);
  });

  it("revokes only what was issued at or before the revocation", async () => {
    const handle = await openDatabase(url);
    const set = track(
      new RevocationSet({ database: counted(handle), horizonMs: HORIZON_MS }),
    );
    await set.ready();
    const at = Date.now();
    await revoke(handle, "grant", "g-4", at);
    await eventually(() => set.isRevoked({ kind: "grant", id: "g-4" }));
    expect(await set.isRevoked({ kind: "grant", id: "g-4" }, at - 1000)).toBe(true);
    expect(await set.isRevoked({ kind: "grant", id: "g-4" }, at + 1000)).toBe(false);
  });

  it("forgets revocations older than the horizon", async () => {
    const handle = await openDatabase(url);
    await revoke(handle, "grant", "g-old", Date.now() - HORIZON_MS - 1000);
    const set = track(
      new RevocationSet({ database: counted(handle), horizonMs: HORIZON_MS }),
    );
    await set.ready();
    expect(await set.isRevoked({ kind: "grant", id: "g-old" })).toBe(false);
  });

  it("aborts a watching signal when its session is revoked", async () => {
    const handle = await openDatabase(url);
    const set = track(
      new RevocationSet({ database: counted(handle), horizonMs: HORIZON_MS }),
    );
    await set.ready();
    const watched = set.signal([{ kind: "session", id: "s-1" }]);
    const other = set.signal([{ kind: "session", id: "s-2" }]);
    await revoke(handle, "session", "s-1");
    await eventually(() => watched.aborted);
    expect(other.aborted).toBe(false);
  });
});

describe("RevocationSet across a lost LISTEN connection", () => {
  it("checks per call during the gap and follows again after reloading", async () => {
    const handle = await openDatabase();
    const { provider, drop } = droppable(handle);
    const set = track(
      new RevocationSet({
        database: provider,
        horizonMs: HORIZON_MS,
        relistenBaseMs: 20,
      }),
    );
    await set.ready();
    const watched = set.signal([{ kind: "session", id: "s-gap" }]);

    drop(2);
    expect(set.mode).toBe("checking");
    await revoke(handle, "grant", "g-gap");
    await revoke(handle, "session", "s-gap");
    expect(await set.isRevoked({ kind: "grant", id: "g-gap" })).toBe(true);

    await eventually(() => set.mode === "following");
    expect(await set.isRevoked({ kind: "grant", id: "g-gap" })).toBe(true);
    expect(watched.aborted).toBe(true);
  });

  it("starts in checking mode when LISTEN fails at startup and recovers", async () => {
    const handle = await openDatabase();
    await revoke(handle, "grant", "g-before");
    const { provider, refuse } = droppable(handle);
    refuse(1);
    const set = track(
      new RevocationSet({
        database: provider,
        horizonMs: HORIZON_MS,
        relistenBaseMs: 20,
      }),
    );
    await set.ready();
    expect(set.mode).toBe("checking");
    expect(await set.isRevoked({ kind: "grant", id: "g-before" })).toBe(true);
    await eventually(() => set.mode === "following");
    expect(await set.isRevoked({ kind: "grant", id: "g-before" })).toBe(true);
    await revoke(handle, "grant", "g-after");
    await eventually(() => set.isRevoked({ kind: "grant", id: "g-after" }));
  });
});

describe.runIf(postgresUrl)(
  "RevocationSet when Postgres drops the LISTEN connection",
  () => {
    it("still refuses a grant revoked while the connection was down", async () => {
      const handle = await openDatabase(postgresUrl);
      const set = track(
        new RevocationSet({
          database: counted(handle),
          horizonMs: HORIZON_MS,
          relistenBaseMs: 500,
        }),
      );
      await set.ready();
      const admin = new pg.Client({ connectionString: postgresUrl });
      await admin.connect();
      try {
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN "${REVOCATION_CHANNEL}"'`,
        );
      } finally {
        await admin.end();
      }
      await eventually(() => set.mode === "checking");
      await revoke(handle, "grant", "g-dropped");
      expect(await set.isRevoked({ kind: "grant", id: "g-dropped" })).toBe(true);
      await eventually(() => set.mode === "following", 5000);
      expect(await set.isRevoked({ kind: "grant", id: "g-dropped" })).toBe(true);
    });
  },
);
