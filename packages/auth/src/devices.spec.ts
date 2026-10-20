import { decodeBase64url, enrollmentBytes } from "@parlor/capabilities/encoding";
import { asId } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { rowsOf } from "./database.js";
import { DEVICES_MIGRATION } from "./devices.js";
import {
  type Browser,
  createTestApp,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { TestDeviceKey } from "./testing/device.js";

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
  app = createTestApp(database);
});

afterEach(async () => {
  await app.server.close();
  await database.db.execute(
    sql`do $$ begin
      if to_regclass('parlor_auth_devices') is not null then
        delete from parlor_auth_devices;
        delete from parlor_auth_device_challenges;
      end if;
    end $$`,
  );
});

const signUp = (name: string) => signUpAs(app.server, name);

const rows = async <T>(query: ReturnType<typeof sql>) =>
  rowsOf<T>(await database.db.execute(query));

const userIdOf = async (browser: Browser) =>
  asId(
    "user",
    (await (await browser.post("/_parlor/actions/whoami", {})).json()).data.principal
      .userId,
  );

async function enroll(
  browser: Browser,
  device: TestDeviceKey,
  tweak: (input: Record<string, any>) => void = () => {},
) {
  const { challenge } = (await browser.account("deviceChallenge")).body.data;
  const keys = await device.publicKeys({
    rpId: "hello.example",
    userId: "u",
    userName: "u",
    challenge: decodeBase64url(challenge),
  });
  const input: Record<string, any> = {
    name: "Chrome on macOS",
    platform: "web",
    challenge,
    signing: keys.signing,
    ...(keys.presence ? { presence: keys.presence } : {}),
    proof: keys.proof,
  };
  tweak(input);
  return browser.account("enrollDevice", input);
}

describe("auth/0004_devices", () => {
  it("is a free migration id whose statements are plain", () => {
    expect(DEVICES_MIGRATION.id).toBe("auth/0004_devices");
    expect(DEVICES_MIGRATION.sql).not.toContain("$");
  });

  it("creates the device and challenge tables the provider registers", async () => {
    await signUp("Alice");
    expect(
      await rows(
        sql`select tablename from pg_tables where tablename like 'parlor_auth_device%' order by tablename`,
      ),
    ).toEqual([
      { tablename: "parlor_auth_device_challenges" },
      { tablename: "parlor_auth_devices" },
    ]);
  });
});

describe("enrolling a device", () => {
  it("registers the keys the device proved it holds and gives the host plain keys back", async () => {
    const alice = await signUp("Alice");
    const device = new TestDeviceKey();
    const enrolled = await enroll(alice, device);
    expect(enrolled.status).toBe(200);
    const id = enrolled.body.data.id as string;
    const keys = await device.publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "u",
      challenge: new Uint8Array([1]),
    });
    const registered = await app.provider.device!(
      await userIdOf(alice),
      asId("device", id),
    );
    expect(registered).toEqual({
      id,
      name: "Chrome on macOS",
      platform: "web",
      signingKey: keys.signing.publicKey,
      presenceKey: keys.presence && {
        format: "es256-raw",
        keyId: keys.presence.format === "es256-raw" ? keys.presence.keyId : "",
        publicKey: keys.presence.publicKey,
      },
    });
    expect(Object.keys(registered!).sort()).toEqual(
      ["id", "name", "platform", "presenceKey", "signingKey"].sort(),
    );
  });

  it("keeps a webauthn presence key with the relying party it was made for", async () => {
    const alice = await signUp("Alice");
    const passkey = (
      await new TestDeviceKey().publicKeys({
        rpId: "hello.example",
        userId: "u",
        userName: "u",
        challenge: new Uint8Array([1]),
      })
    ).signing.publicKey;
    const device = new TestDeviceKey(false);
    const enrolled = await (async () => {
      const { challenge } = (await alice.account("deviceChallenge")).body.data;
      const keys = await device.publicKeys({
        rpId: "hello.example",
        userId: "u",
        userName: "u",
        challenge: decodeBase64url(challenge),
      });
      const presence = {
        format: "webauthn" as const,
        credentialId: "cred-1",
        publicKey: passkey,
        attestation: "oA",
      };
      const proof = await device.sign(
        enrollmentBytes({
          challenge: decodeBase64url(challenge),
          signing: keys.signing.publicKey,
          presence,
        }),
        { presence: false },
      );
      return alice.account("enrollDevice", {
        name: "Chrome",
        platform: "web",
        challenge,
        signing: keys.signing,
        presence: { ...presence, rpId: "hello.example" },
        proof,
      });
    })();
    expect(enrolled.status).toBe(200);
    expect(
      (
        await rows<{ presence_key: unknown }>(
          sql`select presence_key from parlor_auth_devices`,
        )
      )[0]?.presence_key,
    ).toEqual({
      format: "webauthn",
      credentialId: "cred-1",
      rpId: "hello.example",
      publicKey: { kty: passkey.kty, crv: passkey.crv, x: passkey.x, y: passkey.y },
    });
  });

  it("enrolls a device without a presence key", async () => {
    const alice = await signUp("Alice");
    const enrolled = await enroll(alice, new TestDeviceKey(false));
    expect(enrolled.status).toBe(200);
    expect(await rows(sql`select presence_key from parlor_auth_devices`)).toEqual([
      { presence_key: null },
    ]);
  });

  it("answers the same id when the same keys enroll again, writing nothing new", async () => {
    const alice = await signUp("Alice");
    const device = new TestDeviceKey();
    const first = await enroll(alice, device);
    const again = await enroll(alice, device);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await rows(sql`select id from parlor_auth_devices`)).toHaveLength(1);
  });

  it("refuses a proof made over another challenge or other keys", async () => {
    const alice = await signUp("Alice");
    const device = new TestDeviceKey();
    const other = await enroll(alice, new TestDeviceKey(), (input) => {
      input.proof = undefined;
    });
    expect(other.status).toBe(400);
    const borrowed = await new TestDeviceKey().publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "u",
      challenge: new Uint8Array([1]),
    });
    const swapped = await enroll(alice, device, (input) => {
      input.proof = borrowed.proof;
    });
    expect(swapped).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_input" } },
    });
    const claimed = await enroll(alice, device, (input) => {
      input.signing = borrowed.signing;
    });
    expect(claimed.status).toBe(400);
    expect(await rows(sql`select id from parlor_auth_devices`)).toEqual([]);
  });

  it("refuses a proof that does not cover the presence key it carries", async () => {
    const alice = await signUp("Alice");
    const other = await new TestDeviceKey().publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "u",
      challenge: new Uint8Array([1]),
    });
    const refused = await enroll(alice, new TestDeviceKey(), (input) => {
      input.presence = other.presence;
    });
    expect(refused.status).toBe(400);
  });

  it("takes each challenge once", async () => {
    const alice = await signUp("Alice");
    const device = new TestDeviceKey();
    const { challenge } = (await alice.account("deviceChallenge")).body.data;
    const send = async () => {
      const keys = await device.publicKeys({
        rpId: "hello.example",
        userId: "u",
        userName: "u",
        challenge: decodeBase64url(challenge),
      });
      return alice.account("enrollDevice", {
        name: "A",
        platform: "web",
        challenge,
        signing: keys.signing,
        presence: keys.presence,
        proof: keys.proof,
      });
    };
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(400);
  });

  it("refuses a challenge another account was issued, and an expired one", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const { challenge } = (await alice.account("deviceChallenge")).body.data;
    const device = new TestDeviceKey();
    const keys = await device.publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "u",
      challenge: decodeBase64url(challenge),
    });
    const stolen = await bob.account("enrollDevice", {
      name: "B",
      platform: "web",
      challenge,
      signing: keys.signing,
      presence: keys.presence,
      proof: keys.proof,
    });
    expect(stolen.status).toBe(400);
    await database.db.execute(
      sql`update parlor_auth_device_challenges set expires_at = now() - interval '1 second'`,
    );
    const late = await alice.account("enrollDevice", {
      name: "A",
      platform: "web",
      challenge,
      signing: keys.signing,
      presence: keys.presence,
      proof: keys.proof,
    });
    expect(late.status).toBe(400);
  });

  it("needs a signed-in user", async () => {
    const anonymous = await app.server.fetch(
      new Request("http://localhost:3000/_parlor/auth/actions/deviceChallenge", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: "{}",
      }),
    );
    expect(anonymous.status).toBeGreaterThanOrEqual(401);
    expect(anonymous.status).toBeLessThan(500);
  });
});

describe("listing and revoking devices", () => {
  it("lists a user's own devices only", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    await enroll(alice, new TestDeviceKey());
    await enroll(bob, new TestDeviceKey());
    const listed = (await alice.account("devices")).body.data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "Chrome on macOS",
      platform: "web",
      current: false,
    });
  });

  it("makes a revoked device unknown to every host and says not found to anyone else", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const id = (await enroll(alice, new TestDeviceKey())).body.data.id as string;
    const aliceId = await userIdOf(alice);
    expect((await bob.account("revokeDevice", { id })).status).toBe(404);
    expect(await app.provider.device!(aliceId, asId("device", id))).toBeDefined();
    expect((await alice.account("revokeDevice", { id })).body.data).toEqual({ id });
    expect(await app.provider.device!(aliceId, asId("device", id))).toBeUndefined();
    expect((await alice.account("devices")).body.data).toEqual([]);
    expect((await alice.account("revokeDevice", { id })).status).toBe(404);
  });

  it("lets a revoked device's keys enroll again as a new device", async () => {
    const alice = await signUp("Alice");
    const device = new TestDeviceKey();
    const first = (await enroll(alice, device)).body.data.id;
    await alice.account("revokeDevice", { id: first });
    const second = (await enroll(alice, device)).body.data.id;
    expect(second).not.toBe(first);
  });

  it("never gives another account's device to a host asking for it", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const id = (await enroll(alice, new TestDeviceKey())).body.data.id as string;
    expect(
      await app.provider.device!(await userIdOf(bob), asId("device", id)),
    ).toBeUndefined();
  });
});
