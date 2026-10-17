import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INITIAL_CURSOR } from "../protocol.js";
import {
  ensureSyncTables,
  type NotifyPayload,
  pruneSyncEvents,
  readSyncEvents,
  recordSyncEvent,
} from "./store.js";

let handle: DatabaseHandle;
beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  await ensureSyncTables(handle.db);
  await ensureSyncTables(handle.db);
});
afterAll(() => handle.close());

describe("sync store", () => {
  it("allocates increasing versions and reads them back after a cursor, per scope", async () => {
    const a = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "acme", tags: [["tasks", "1"]], source: "tab-1" }),
    );
    const b = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "acme", tags: [["tasks", "2"]] }),
    );
    await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "other", tags: [["tasks"]] }),
    );
    expect(b.version).toBeGreaterThan(a.version);

    const all = await readSyncEvents(handle.db, "acme", INITIAL_CURSOR);
    expect(all.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(all[0]?.source).toBe("tab-1");
    expect(all[0]?.tags).toEqual([["tasks", "1"]]);

    const after = await readSyncEvents(handle.db, "acme", {
      version: a.version,
      id: a.id,
    });
    expect(after.map((e) => e.id)).toEqual([b.id]);
  });

  it("does not record events for rolled back transactions", async () => {
    const before = await readSyncEvents(handle.db, "rollback", INITIAL_CURSOR);
    await handle
      .transaction(async (tx) => {
        await recordSyncEvent(tx, { scope: "rollback", tags: [["tasks"]] });
        throw new Error("abort");
      })
      .catch(() => {});
    const after = await readSyncEvents(handle.db, "rollback", INITIAL_CURSOR);
    expect(after).toHaveLength(before.length);
  });

  it("notifies listeners on commit with the scope and event", async () => {
    const received: string[] = [];
    const unlisten = await handle.listen("parlor_sync", (payload) => {
      received.push(payload);
    });
    const event = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "acme", tags: [["tasks", "9"]] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await unlisten();
    expect(received.map((p) => JSON.parse(p))).toContainEqual({ scope: "acme", event });
  });

  it("keeps a bulk write's NOTIFY under the pg_notify limit by collapsing to table tags", async () => {
    const received: string[] = [];
    const unlisten = await handle.listen("parlor_sync", (payload) => {
      received.push(payload);
    });
    const tags = Array.from({ length: 300 }, () => ["tasks", crypto.randomUUID()]);
    const event = await handle.transaction((tx) =>
      recordSyncEvent(tx, { scope: "bulk", tags }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await unlisten();

    const stored = await readSyncEvents(handle.db, "bulk", INITIAL_CURSOR);
    expect(stored[0]?.tags).toEqual(tags);
    const notified = received
      .map((p) => JSON.parse(p) as NotifyPayload)
      .find((p) => p.scope === "bulk");
    expect(notified?.event).toEqual({ ...event, tags: [["tasks"]] });
    expect(received.every((p) => new TextEncoder().encode(p).length < 8000)).toBe(true);
  });

  it("prunes only events older than the retention window", async () => {
    await handle.db.execute(
      sql`update sync_events set created_at = now() - interval '2 days' where scope = 'other'`,
    );
    const deleted = await pruneSyncEvents(handle.db);
    expect(deleted).toBe(1);
    expect(await readSyncEvents(handle.db, "other", INITIAL_CURSOR)).toHaveLength(0);
    expect(
      (await readSyncEvents(handle.db, "acme", INITIAL_CURSOR)).length,
    ).toBeGreaterThan(0);
  });
});
