import { chat } from "@parlor/chat/server";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type Browser,
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { callWith, Computer, pair } from "./testing/computer.js";
import { enroll, TestDeviceKey } from "./testing/device.js";

let database: DatabaseHandle;
let app: TestApp;
let admins: Set<string>;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute(sql`select 1`);
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`drop schema public cascade`);
  await database.db.execute(sql`create schema public`);
  admins = new Set();
  app = createTestApp(database, {
    plugins: [chat({ access: ({ userId }) => admins.has(userId) })],
  });
});

afterEach(async () => {
  await app.server.close();
});

async function signUp(name: string, admin: boolean): Promise<Browser> {
  const browser = await signUpAs(app.server, name);
  if (admin) {
    const reply = await browser.post("/_parlor/actions/whoami", {});
    const { data } = (await reply.json()) as { data: { principal: { userId: string } } };
    admins.add(data.principal.userId);
  }
  return browser;
}

const forbidden = { status: 403, body: { error: { code: "forbidden" } } };

const LINK_CODE = "ABCDEFGHJK";

describe("auth for a user chat({ access }) refuses", () => {
  it("shows no consent page and issues no pairing code", async () => {
    const bob = await signUp("Bob", false);
    const computer = new Computer();
    const page = await bob.fetch(
      `/_parlor/auth/hosts/authorize?${await computer.authorizeQuery()}`,
    );
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("This account cannot use the agent.");
    const answer = await computer.approve(bob);
    expect(answer.status).toBe(403);
    expect(answer.headers.get("location")).toBeNull();
    const json = await bob.post("/_parlor/auth/hosts/authorize", {
      ...(await computer.pairing()),
      decision: "connect",
    });
    expect({ status: json.status, body: await json.json() }).toMatchObject(forbidden);
  });

  it("enrolls and links no device", async () => {
    const bob = await signUp("Bob", false);
    expect(await bob.account("deviceChallenge")).toMatchObject(forbidden);
    expect(
      await bob.account("startDeviceLink", { device: "d1", code: LINK_CODE }),
    ).toMatchObject(forbidden);
    expect(await bob.account("resolveDeviceLink", { code: LINK_CODE })).toMatchObject(
      forbidden,
    );
    expect(
      await bob.account("vouchDevice", {
        device: "d1",
        voucher: "d2",
        app: ORIGIN,
        commitment: "a".repeat(43),
        at: Date.now(),
        signature: { keyId: "k", presence: "user", format: "es256-raw", signature: "s" },
      }),
    ).toMatchObject(forbidden);
  });

  it("still lists and removes what the user already has", async () => {
    const bob = await signUp("Bob", false);
    expect((await bob.account("hosts")).status).toBe(200);
    expect((await bob.account("devices")).status).toBe(200);
  });

  it("refuses a computer paired before the user was refused, on chat and on device links", async () => {
    const alice = await signUp("Alice", true);
    const computer = await pair(app.server, alice);
    const hostCall = async (path: string) =>
      callWith(
        app.server,
        path,
        `ParlorHost ${await computer.assertion({ url: `${ORIGIN}${path}` })}`,
      );
    expect((await hostCall("/_parlor/chat/heartbeat")).status).toBe(204);

    admins.clear();
    expect(await hostCall("/_parlor/chat/actions/hostClaim")).toMatchObject(forbidden);
    expect(await hostCall("/_parlor/chat/heartbeat")).toMatchObject(forbidden);
    expect(await hostCall("/_parlor/auth/hosts/devices/link")).toMatchObject(forbidden);
  });
});

describe("auth for a user chat({ access }) allows", () => {
  it("pairs a computer and enrolls a device as before", async () => {
    const alice = await signUp("Alice", true);
    const computer = await pair(app.server, alice);
    expect(computer.grant?.grant.hostId).toEqual(expect.any(String));
    expect((await enroll(alice, new TestDeviceKey())).status).toBe(200);
  });
});
