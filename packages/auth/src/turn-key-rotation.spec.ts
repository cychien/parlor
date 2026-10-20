import { asId, type DataProvider, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rowsOf } from "./database.js";
import { createTestApp, signUp as signUpAs, type TestApp } from "./testing/app.js";
import { pair } from "./testing/computer.js";
import { createTurnKeyStore } from "./turn-keys.js";

const OLD_SECRET = "the-secret-before-the-rotation-at-least-32-chars";
const NEW_SECRET = "the-secret-after-the-rotation-at-least-32-chars!";

let database: DatabaseHandle;
const apps: TestApp[] = [];

beforeEach(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterEach(async () => {
  for (const app of apps.splice(0)) await app.server.close();
  await database.close();
});

const provider = (): DataProvider => ({
  read: () => database.read(),
  transaction: (run) => database.transaction(run),
});

const keyRows = async () =>
  rowsOf<{ kid: string; active: boolean }>(
    await database.db.execute(
      sql`select kid, active from parlor_auth_turn_keys order by created_at, kid`,
    ),
  );

function appWith(secret: string) {
  const app = createTestApp(database, { secret });
  apps.push(app);
  return app;
}

async function keyBeforeRotation() {
  const first = appWith(OLD_SECRET);
  const carol = await signUpAs(first.server, "Carol");
  await carol.post("/_parlor/actions/whoami", {});
  await vi.waitFor(async () => expect(await keyRows()).toHaveLength(1));
  await first.server.close();
  apps.length = 0;
  return (await keyRows())[0]!.kid;
}

describe("a turn signing key sealed under a rotated secret", () => {
  it("does not stop sessions from authenticating", async () => {
    await keyBeforeRotation();
    const app = appWith(NEW_SECRET);
    const alice = await signUpAs(app.server, "Alice");
    const whoami = await alice.post("/_parlor/actions/whoami", {});
    expect(whoami.status).toBe(200);
    expect(((await whoami.json()) as any).data.principal.kind).toBe("user");
  });

  it("is retired by the first delegate, which signs with a fresh key", async () => {
    const before = await keyBeforeRotation();
    const app = appWith(NEW_SECRET);
    const alice = await signUpAs(app.server, "Alice");
    const computer = await pair(app.server, alice);
    const { grant, account } = computer.grant!;
    const principal: HostPrincipal = {
      kind: "host",
      userId: account.userId,
      grantId: grant.id,
      hostId: grant.hostId,
    };
    const delegation = await app.provider.delegate!(principal, {
      threadId: asId("thread", "thr-1"),
      turnId: asId("turn", "trn-1"),
      clientId: "tab-1",
      agent: "Claude Code",
      ttlMs: 60_000,
    });
    expect(delegation.token.split(".")).toHaveLength(3);
    expect(await keyRows()).toEqual([
      { kid: before, active: false },
      { kid: expect.any(String), active: true },
    ]);
  });

  it("is replaced by exactly one key when several instances find it at once", async () => {
    const before = await keyBeforeRotation();
    const stores = [1, 2, 3].map(() =>
      createTurnKeyStore({
        database: provider(),
        issuer: "http://localhost:3000/_parlor/auth",
        secret: () => Promise.resolve(NEW_SECRET),
      }),
    );
    const loaded = await Promise.all(stores.map((store) => store.keys()));
    expect(new Set(loaded.map((keys) => keys.kid)).size).toBe(1);
    const rows = await keyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kid: before, active: false });
    expect(rows[1]).toEqual({ kid: loaded[0]!.kid, active: true });
    expect([...loaded[0]!.publicKeys.keys()].sort()).toEqual(
      [before, loaded[0]!.kid].sort(),
    );
  });
});
