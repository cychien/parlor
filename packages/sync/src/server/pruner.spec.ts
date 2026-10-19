import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPruner } from "./pruner.js";
import { ensureSyncTables, readSyncEvents, recordSyncEvent } from "./store.js";

let handle: DatabaseHandle;
beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  await ensureSyncTables(handle.db);
}, 30_000);
afterAll(() => handle.close());

describe("createPruner", () => {
  it("prunes at most once per interval", async () => {
    await handle.transaction((tx) => recordSyncEvent(tx, { scope: "p", tags: [["t"]] }));
    await handle.db.execute(
      sql`update sync_events set created_at = now() - interval '3 days'`,
    );
    let clock = 0;
    const pruner = createPruner(handle, { intervalMs: 1000, now: () => clock });

    pruner.touch();
    await new Promise((r) => setTimeout(r, 50));
    expect(await readSyncEvents(handle.db, "p", { version: 0, id: "" })).toHaveLength(1);

    clock = 1500;
    pruner.touch();
    await new Promise((r) => setTimeout(r, 100));
    expect(await readSyncEvents(handle.db, "p", { version: 0, id: "" })).toHaveLength(0);
  });
});
