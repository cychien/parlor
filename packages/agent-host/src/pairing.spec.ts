import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { pair, type PairInput, pairingDeviceOf, startLocalPairing } from "./pairing.js";
import type { LocalPrompter } from "./prompter.js";
import { type Browser, memoryHostKeys, type SpecApp, startSpecApp } from "./spec-kit.js";

let app: SpecApp;

beforeAll(async () => {
  vi.stubEnv("PARLOR_APP_NAME", "Hello");
  app = await startSpecApp();
}, 60_000);

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Prompted {
  readonly appName: string;
  readonly account: { readonly email?: string | undefined };
  readonly matchingCode: string;
}

function prompter(answer: boolean, prompted: Prompted[]): LocalPrompter {
  return {
    confirmPairing: async (input) => {
      prompted.push(input);
      return answer;
    },
    approveDevice: async () => false,
    answerHere: async () => undefined,
    turnStarted: () => undefined,
  };
}

function connectAs(
  browser: Browser,
  options: { readonly confirm?: boolean; readonly decision?: "connect" | "cancel" } = {},
) {
  const keys = memoryHostKeys();
  const prompted: Prompted[] = [];
  const opened: { url: string; page: string; statusesBefore: number[] }[] = [];
  const statuses: number[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await realFetch(...args);
    statuses.push(response.status);
    return response;
  });
  const input: PairInput = {
    appOrigin: app.origin,
    hostName: "Alice's MacBook Pro",
    platform: "macos",
    keys,
    prompter: prompter(options.confirm ?? true, prompted),
    workspaceRoot: "/Users/alice/Parlor",
    channel: {
      kind: "browser",
      open: async (url) => {
        const statusesBefore = [...statuses];
        const { page, answer } = await browser.consent(
          url,
          options.decision ?? "connect",
        );
        opened.push({ url, page, statusesBefore });
        void fetch(answer.headers.get("location")!);
      },
    },
  };
  return { outcome: pair(input), keys, prompted, opened };
}

describe("pairing a computer from its terminal", () => {
  it("T4-06: reads the app's name without a session and pairs as the signed-in user", async () => {
    const bob = await app.signUp("Bob");
    const bobs = connectAs(bob);
    const bobOutcome = await bobs.outcome;
    expect(bobOutcome.paired).toBe(true);
    vi.restoreAllMocks();

    for (const authorization of [
      undefined,
      `ParlorHost ${await bobs.keys.assert(app.origin, {
        method: "GET",
        url: `${app.origin}/_parlor/manifest`,
      })}`,
    ]) {
      const response = await fetch(`${app.origin}/_parlor/manifest`, {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { app?: unknown }).app).toEqual({
        name: "Hello",
      });
    }

    const alice = await app.signUp("Alice");
    const alices = connectAs(alice);
    const outcome = await alices.outcome;

    expect(alices.opened).toHaveLength(1);
    const [opened] = alices.opened;
    expect(new URL(opened!.url).pathname).toBe("/_parlor/auth/hosts/authorize");
    expect(
      opened!.statusesBefore.filter((status) => status === 401 || status === 403),
    ).toEqual([]);
    expect(opened!.page).toContain("Connect a computer to Hello?");
    const code = new URL(opened!.url).searchParams.get("matchingCode")!;
    expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(opened!.page).toContain(code);
    expect(alices.prompted).toEqual([
      expect.objectContaining({
        appName: "Hello",
        account: expect.objectContaining({ email: "alice@example.com" }),
        matchingCode: code,
      }),
    ]);
    expect(outcome).toMatchObject({
      paired: true,
      grant: {
        appOrigin: app.origin,
        appName: "Hello",
        account: { email: "alice@example.com" },
        workspace: `/Users/alice/Parlor/${new URL(app.origin).host.replace(":", "-")}`,
      },
    });
    expect(alices.keys.origins()).toEqual([app.origin]);
  });

  it("forgets the key and revokes the grant when the account shown is declined here", async () => {
    const carol = await app.signUp("Carol");
    const attempt = connectAs(carol, { confirm: false });
    expect(await attempt.outcome).toEqual({ paired: false, reason: "declined_locally" });
    expect(attempt.keys.origins()).toEqual([]);
    const hosts = await carol.fetch("/_parlor/auth/actions/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(((await hosts.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("stops when the consent page is cancelled", async () => {
    const dave = await app.signUp("Dave");
    const attempt = connectAs(dave, { decision: "cancel" });
    expect(await attempt.outcome).toEqual({ paired: false, reason: "declined_in_app" });
    expect(attempt.prompted).toEqual([]);
  });
});

describe("pairing a computer from the desktop app", () => {
  const authorize = async (
    browser: Browser,
    pairing: Record<string, unknown>,
    decision: "connect" | "cancel" = "connect",
  ) => {
    const response = await browser.fetch("/_parlor/auth/hosts/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...pairing, redirectUri: "urn:parlor:ipc", decision }),
    });
    return ((await response.json()) as { code: string }).code;
  };

  const start = (keys = memoryHostKeys()) => ({
    keys,
    local: startLocalPairing({
      appOrigin: app.origin,
      hostName: "Alice's MacBook Pro",
      platform: "macos",
      keys,
      workspaceRoot: "/Users/alice/Parlor",
    }),
  });

  it("C8: shows the account and code the host got from the backend, and pairs once the user confirms", async () => {
    const alice = await app.signUp("Ivy");
    const { keys, local } = start();
    const pairing = await local.pairing;
    expect(pairing).toMatchObject({
      hostName: "Alice's MacBook Pro",
      platform: "macos",
      matchingCode: expect.stringMatching(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/),
    });
    const review = await local.finish(await authorize(alice, pairing));
    expect(review).toEqual({
      account: "ivy@example.com",
      appName: "Hello",
      matchingCode: pairing.matchingCode,
    });
    expect(keys.origins()).toEqual([]);
    expect(await local.confirm(true)).toMatchObject({
      paired: true,
      grant: { appOrigin: app.origin, account: { email: "ivy@example.com" } },
    });
    expect(keys.origins()).toEqual([app.origin]);
  });

  it("revokes the grant and keeps nothing when the user cancels the native dialog", async () => {
    const jack = await app.signUp("Jack");
    const { keys, local } = start();
    const review = local.finish(await authorize(jack, await local.pairing));
    await review;
    expect(await local.confirm(false)).toEqual({
      paired: false,
      reason: "declined_locally",
    });
    expect(keys.origins()).toEqual([]);
    const hosts = await jack.fetch("/_parlor/auth/actions/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(((await hosts.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("fails the finish when the code is not one the backend issued for this pairing", async () => {
    const { local } = start();
    await local.pairing;
    await expect(local.finish("not-a-code")).rejects.toThrow();
  });
});

describe("pairingDeviceOf", () => {
  const device = {
    deviceId: "device-1",
    name: "Hello on macOS",
    platform: "tauri",
    signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "private" },
    presenceKey: {
      format: "es256-raw",
      keyId: "k",
      publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "private" },
    },
  };

  it("keeps the public point of each key and nothing else", () => {
    expect(pairingDeviceOf(device)).toEqual({
      deviceId: "device-1",
      name: "Hello on macOS",
      platform: "tauri",
      signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      presenceKey: {
        format: "es256-raw",
        keyId: "k",
        publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      },
    });
  });

  it("drops a presence key that is not whole, and refuses a device with no usable signing key", () => {
    expect(
      pairingDeviceOf({ ...device, presenceKey: { format: "webauthn" } }),
    ).toMatchObject({
      presenceKey: undefined,
    });
    expect(pairingDeviceOf({ ...device, signingKey: { kty: "RSA" } })).toBeUndefined();
    expect(pairingDeviceOf({ ...device, deviceId: "" })).toBeUndefined();
    expect(pairingDeviceOf(null)).toBeUndefined();
  });
});
