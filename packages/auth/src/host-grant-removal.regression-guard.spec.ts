import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { rowsOf } from "./database.js";
import {
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { Computer, pair } from "./testing/computer.js";

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

const rowsFor = async (grantId: string) => ({
  keys: rowsOf(
    await database
      .read()
      .execute(sql`select grant_id from parlor_auth_hosts where grant_id = ${grantId}`),
  ),
  revocations: rowsOf(
    await database
      .read()
      .execute(
        sql`select id from parlor_auth_revocations where kind = 'grant' and id = ${grantId}`,
      ),
  ),
});

describe("removing a computer's grant", () => {
  it("deletes the key row along with recording the revocation, however it is disconnected", async () => {
    app = createTestApp(database);
    const alice = await signUpAs(app.server, "Alice");
    const byAccount = await pair(app.server, alice, new Computer("Laptop"));
    const bySelf = await pair(app.server, alice, new Computer("Desktop"));
    const accountGrant = byAccount.grant!.grant;
    const selfGrant = bySelf.grant!.grant;
    expect((await rowsFor(accountGrant.id)).keys).toHaveLength(1);

    await alice.account("revokeHost", { hostId: accountGrant.hostId });
    const url = `${ORIGIN}/_parlor/auth/hosts/revoke`;
    await app.server.fetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: `ParlorHost ${await bySelf.assertion({ url })}` },
      }),
    );

    for (const { id } of [accountGrant, selfGrant]) {
      const { keys, revocations } = await rowsFor(id);
      expect(keys).toEqual([]);
      expect(revocations).toEqual([{ id }]);
    }
  });
});
