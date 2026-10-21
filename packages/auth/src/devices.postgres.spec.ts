import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rowsOf } from "./database.js";
import { createTestApp, signUp, type TestApp } from "./testing/app.js";
import { enroll, TestDeviceKey } from "./testing/device.js";
import {
  createScratchDatabase,
  postgresUrl,
  type ScratchDatabase,
} from "./testing/postgres.js";

if (!postgresUrl) {
  console.info(
    "[parlor] concurrent device enrollment specs skipped: set PARLOR_TEST_DATABASE_URL to run them",
  );
}

describe.skipIf(!postgresUrl)("enrolling one device from two tabs at once", () => {
  let scratch: ScratchDatabase;
  let handle: DatabaseHandle;
  let app: TestApp;

  beforeAll(async () => {
    scratch = await createScratchDatabase(postgresUrl!);
    handle = await createDatabase({ url: scratch.url });
    app = createTestApp(handle);
  }, 30_000);

  afterAll(async () => {
    await app?.server.close();
    await handle?.close();
    await scratch?.drop();
  });

  it("R5-04: ends with one device row, whichever tab wins", async () => {
    const alice = await signUp(app.server, "Alice");
    for (let round = 0; round < 20; round += 1) {
      const device = new TestDeviceKey();
      const [first, second] = await Promise.all([
        enroll(alice, device),
        enroll(alice, device),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.body.data.id).toBe(second.body.data.id);
    }
    const stored = rowsOf<{ readonly n: number }>(
      await handle.db.execute(sql`select count(*)::int as n from parlor_auth_devices`),
    );
    expect(stored).toEqual([{ n: 20 }]);
  });
});
