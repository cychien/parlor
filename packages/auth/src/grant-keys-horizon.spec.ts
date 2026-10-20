import { asId } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { REVOCATION_HORIZON_MS } from "@parlor/server";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGrantKeys } from "./hosts.js";
import { createTestApp, signUp as signUpAs, type TestApp } from "./testing/app.js";
import { pair } from "./testing/computer.js";

let database: DatabaseHandle;
let app: TestApp;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(async () => {
  await database.close();
});

afterEach(async () => {
  await app.server.close();
});

describe("the grant key cache", () => {
  it("lets go of a key by the revocation horizon even when asked to keep it longer", async () => {
    app = createTestApp(database);
    const alice = await signUpAs(app.server, "Alice");
    const computer = await pair(app.server, alice);
    const grantId = computer.grant!.grant.id;
    let clock = 1_000_000;
    const keys = createGrantKeys(database, {
      ttlMs: 100 * REVOCATION_HORIZON_MS,
      now: () => clock,
    });
    expect((await keys.get(grantId))?.grantId).toBe(asId("grant", grantId));

    await database.db.execute(sql`delete from parlor_auth_hosts`);
    clock += REVOCATION_HORIZON_MS - 1;
    expect(await keys.get(grantId)).toBeDefined();
    clock += 1;

    expect(await keys.get(grantId)).toBeUndefined();
  });
});
