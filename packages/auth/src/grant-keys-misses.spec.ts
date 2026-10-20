import { asId, type DataProvider } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { REVOCATION_HORIZON_MS } from "@parlor/server";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGrantKeys, GRANT_MISS_TTL_MS } from "./hosts.js";
import { createTestApp, signUp as signUpAs, type TestApp } from "./testing/app.js";
import { pair } from "./testing/computer.js";

let database: DatabaseHandle;
let app: TestApp;
let reads = 0;

const counting = (handle: DatabaseHandle): DataProvider => ({
  read: () => {
    reads += 1;
    return handle.read();
  },
  transaction: (run) => handle.transaction(run),
});

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
  it("remembers a grant that has no key for a few seconds, well inside the revocation horizon", async () => {
    app = createTestApp(database);
    await signUpAs(app.server, "Alice");
    let clock = 1_000_000;
    const keys = createGrantKeys(counting(database), { now: () => clock });
    const gone = asId("grant", "host:revoked");

    reads = 0;
    expect(await keys.get(gone)).toBeUndefined();
    expect(await keys.get(gone)).toBeUndefined();
    expect(await keys.get(gone)).toBeUndefined();
    expect(reads).toBe(1);

    clock += GRANT_MISS_TTL_MS;
    expect(await keys.get(gone)).toBeUndefined();
    expect(reads).toBe(2);
    expect(GRANT_MISS_TTL_MS).toBeLessThanOrEqual(REVOCATION_HORIZON_MS / 10);
  });

  it("finds a grant paired after a miss once the miss expired", async () => {
    app = createTestApp(database);
    const alice = await signUpAs(app.server, "Alice");
    const computer = await pair(app.server, alice);
    const grantId = computer.grant!.grant.id;
    await database.db.execute(sql`delete from parlor_auth_hosts`);
    let clock = 1_000_000;
    const keys = createGrantKeys(database, { now: () => clock });
    expect(await keys.get(grantId)).toBeUndefined();
    await database.db.execute(sql`
      insert into parlor_auth_hosts (grant_id, host_id, user_id, name, platform, public_key, kid)
      values (${grantId}, 'h-back', 'u', 'Mac', 'macos', ${JSON.stringify(await computer.publicKey())}::jsonb, 'k')`);
    clock += GRANT_MISS_TTL_MS;
    expect((await keys.get(grantId))?.hostId).toBe("h-back");
  });
});
