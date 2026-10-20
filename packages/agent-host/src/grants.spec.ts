import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GrantKey, type GrantKeys, verifyHostAssertion } from "@parlor/auth";
import { asId } from "@parlor/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type AppGrant,
  devHostKeys,
  fileGrantStore,
  keychainHostKeys,
} from "./grants.js";

const ORIGIN = "http://localhost:5301";

const grant = (appOrigin: string, name = "Hello"): AppGrant => ({
  appOrigin,
  appName: name,
  grantId: asId("grant", `host:${name}`),
  hostId: asId("host", `h-${name}`),
  account: { userId: asId("user", "alice"), name: "Alice", email: "alice@example.com" },
  workspace: `/Users/alice/Parlor/${name}`,
  createdAt: 1,
});

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "parlor-grants-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("fileGrantStore", () => {
  it("keeps one grant per app origin in a 0600 file", async () => {
    const file = join(home, ".parlor", "host", "grants.json");
    const store = fileGrantStore(file);
    await Promise.all([
      store.save(grant(ORIGIN)),
      store.save(grant("http://localhost:5302", "B")),
    ]);
    await store.save({ ...grant(ORIGIN), appName: "Hello again" });
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual([
      ORIGIN,
      "http://localhost:5302",
    ]);
    expect((await store.get(ORIGIN))?.appName).toBe("Hello again");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.remove(ORIGIN);
    expect((await store.list()).map((saved) => saved.appOrigin)).toEqual([
      "http://localhost:5302",
    ]);
    expect(await fileGrantStore(join(home, "absent.json")).list()).toEqual([]);
  });
});

describe("keychainHostKeys in an isolated login Keychain", () => {
  const keychain = () => join(home, "Library", "Keychains", "login.keychain-db");

  beforeAll(() => {
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    execFileSync("security", ["create-keychain", "-p", "", keychain()], {
      env: { ...process.env, HOME: home },
    });
  });

  afterAll(() => {
    execFileSync("security", ["delete-keychain", keychain()], {
      env: { ...process.env, HOME: home },
    });
    vi.unstubAllEnvs();
  });

  it("signs assertions the server verifies, bound to the grant, only once the key is kept", async () => {
    const keys = keychainHostKeys("dev.parlor.host.test");
    const pair = await keys.create(ORIGIN);
    const url = `${ORIGIN}/_parlor/chat/actions/hostHello`;
    await expect(keys.assert(ORIGIN, { method: "POST", url })).rejects.toThrow(/no key/);

    await pair.keep(asId("grant", "host:g1"));
    const stored = execFileSync(
      "security",
      ["find-generic-password", "-s", "dev.parlor.host.test", "-a", ORIGIN, "-w"],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );
    expect(stored.trim().length).toBeGreaterThan(0);

    const server: GrantKey = {
      grantId: asId("grant", "host:g1"),
      userId: asId("user", "alice"),
      hostId: asId("host", "h1"),
      publicKey: pair.publicKey,
      kid: pair.thumbprint,
    };
    const grants: GrantKeys = {
      get: async (id) => (id === server.grantId ? server : undefined),
    };
    const assertion = await keychainHostKeys("dev.parlor.host.test").assert(ORIGIN, {
      method: "POST",
      url: `${url}?since=1`,
    });
    await expect(
      verifyHostAssertion(
        assertion as never,
        { method: "POST", url },
        grants,
        Date.now(),
      ),
    ).resolves.toEqual(server);

    await keys.remove(ORIGIN);
    await expect(keys.assert(ORIGIN, { method: "POST", url })).rejects.toThrow(/no key/);
    await keys.remove(ORIGIN);
  });

  it("refuses an account that is not an app origin", async () => {
    await expect(
      keychainHostKeys("dev.parlor.host.test").assert("http://x; rm -rf /", {
        method: "GET",
        url: "http://x/",
      }),
    ).rejects.toThrow(/not an app origin/);
  });
});

describe("devHostKeys", () => {
  it("hands the dev host token to every request and never pairs", async () => {
    const keys = devHostKeys("dev-token");
    expect(await keys.assert(ORIGIN, { method: "GET", url: `${ORIGIN}/x` })).toBe(
      "dev-token",
    );
    await expect(keys.create(ORIGIN)).rejects.toThrow();
  });
});
