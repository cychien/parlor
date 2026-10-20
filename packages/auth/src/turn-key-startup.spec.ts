import { asId, type DataProvider, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, signUp as signUpAs, type TestApp } from "./testing/app.js";
import { pair } from "./testing/computer.js";

let database: DatabaseHandle;
let app: TestApp;
let transactions = 0;

const counting = (provider: DataProvider): DataProvider => ({
  ...provider,
  transaction: (run) => {
    transactions += 1;
    return provider.transaction(run);
  },
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

describe("the turn signing key", () => {
  it("exists before the first delegate, which then writes nothing", async () => {
    app = createTestApp(database, { wrap: counting });
    const alice = await signUpAs(app.server, "Alice");
    const computer = await pair(app.server, alice);
    const { grant, account } = computer.grant!;
    const principal: HostPrincipal = {
      kind: "host",
      userId: account.userId,
      grantId: grant.id,
      hostId: grant.hostId,
    };

    transactions = 0;
    await app.provider.delegate!(principal, {
      threadId: asId("thread", "thr-1"),
      turnId: asId("turn", "trn-1"),
      clientId: "tab-1",
      agent: "Claude Code",
      ttlMs: 60_000,
    });

    expect(transactions).toBe(0);
  });
});
