import { asId, type HostPrincipal } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { rowsOf } from "./database.js";
import {
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { callWith, Computer, HELLO, pair } from "./testing/computer.js";
import { probePlugin } from "./testing/probe.js";

const MINUTE = 60_000;
const START = new Date("2026-10-20T08:00:00.000Z").getTime();

let database: DatabaseHandle;
let app: TestApp;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute(sql`select 1`);
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  app = createTestApp(database, { plugins: [probePlugin] });
});

afterEach(async () => {
  await app.server.close();
  vi.useRealTimers();
});

const at = (offsetMs: number) => vi.setSystemTime(START + offsetMs);

async function eventually(check: () => Promise<boolean>, timeoutMs = 5000) {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > timeoutMs)
      throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const hello = async (computer: Computer) =>
  callWith(
    app.server,
    HELLO,
    `ParlorHost ${await computer.assertion({ url: `${ORIGIN}${HELLO}` })}`,
  );

async function connect() {
  const alice = await signUpAs(app.server, "Alice");
  const computer = await pair(app.server, alice);
  const { grant, account } = computer.grant!;
  const principal: HostPrincipal = {
    kind: "host",
    userId: account.userId,
    grantId: grant.id,
    hostId: grant.hostId,
  };
  return { alice, computer, principal };
}

const turnFor = (principal: HostPrincipal, ttlMs: number) =>
  app.provider.delegate!(principal, {
    threadId: asId("thread", "thr-1"),
    turnId: asId("turn", "trn-1"),
    clientId: "tab-1",
    agent: "Claude Code",
    ttlMs,
  });

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
    iat: number;
    exp: number;
  };

describe("revoking a computer", () => {
  it("refuses its assertions and turn tokens at once, and spares its siblings", async () => {
    const { alice, computer, principal } = await connect();
    const sibling = await pair(app.server, alice, new Computer("Second"));
    const delegation = await turnFor(principal, 120_000);
    expect((await hello(computer)).status).toBe(200);
    expect((await callWith(app.server, HELLO, `Bearer ${delegation.token}`)).status).toBe(
      403,
    );

    await alice.account("revokeHost", { hostId: principal.hostId });

    await eventually(async () => (await hello(computer)).status === 401);
    expect((await callWith(app.server, HELLO, `Bearer ${delegation.token}`)).status).toBe(
      401,
    );
    expect((await hello(sibling)).status).toBe(200);
  });

  it("lets the computer disconnect itself", async () => {
    const { computer } = await connect();
    const url = `${ORIGIN}/_parlor/auth/hosts/revoke`;
    const jws = await computer.assertion({ url });
    const response = await callWith(
      app.server,
      "/_parlor/auth/hosts/revoke",
      `ParlorHost ${jws}`,
    );
    expect(response).toMatchObject({
      status: 200,
      body: { id: computer.grant!.grant.id },
    });
    await eventually(async () => (await hello(computer)).status === 401);
  });

  it("keeps refusing the computer after the revocation set has forgotten it and the server restarted", async () => {
    const { alice, computer } = await connect();
    const grantId = computer.grant!.grant.id;
    expect((await hello(computer)).status).toBe(200);
    await alice.account("revokeHost", { hostId: computer.grant!.grant.hostId });

    await app.server.close();
    at(12 * MINUTE);
    app = createTestApp(database, { plugins: [probePlugin] });

    expect((await hello(computer)).status).toBe(401);
    expect(
      rowsOf(
        await database.db.execute(
          sql`select 1 from parlor_auth_revocations where id = ${grantId}`,
        ),
      ),
    ).toEqual([]);
    expect(
      rowsOf(
        await database.db.execute(
          sql`select 1 from parlor_auth_hosts where grant_id = ${grantId}`,
        ),
      ),
    ).toEqual([]);
  });
});

describe("turn token lifetime", () => {
  it("lasts as long as the lease", async () => {
    const { principal } = await connect();
    const { token, expiresAt } = await turnFor(principal, 120_000);
    const { iat, exp } = claimsOf(token);
    expect(exp - iat).toBe(120);
    expect(expiresAt).toBe(exp * 1000);
  });

  it("is clamped to 600 s whatever the lease asks", async () => {
    const { principal } = await connect();
    const { token, expiresAt } = await turnFor(principal, 15 * MINUTE);
    const { iat, exp } = claimsOf(token);
    expect(exp - iat).toBe(600);
    expect(expiresAt - START).toBe(600_000);
  });

  it("is refused at every point of its lifetime once its grant is revoked", async () => {
    const { alice, principal } = await connect();
    const { token } = await turnFor(principal, 15 * MINUTE);
    const bearer = `Bearer ${token}`;
    expect((await callWith(app.server, HELLO, bearer)).status).toBe(403);

    at(1000);
    await alice.account("revokeHost", { hostId: principal.hostId });

    for (const seconds of [1, 2, 3, 30, 120, 300, 480, 599, 600, 601, 700]) {
      at(seconds * 1000);
      const response = await callWith(app.server, HELLO, bearer);
      expect(response.status, `${seconds} s after minting`).toBe(401);
    }
  });
});
