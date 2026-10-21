import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PROTOCOL } from "@parlor/chat";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { acpLauncher } from "./acp.js";
import { type ControlClient, connectControl } from "./control.js";
import { createHostDaemon, type ServiceDaemon } from "./daemon.js";
import { fileGrantStore } from "./grants.js";
import { createMcpProxy } from "./mcp-proxy.js";
import { hostPaths } from "./paths.js";
import { DEV_POLICY } from "./policy.js";
import { createSessionPool } from "./pool.js";
import { type Browser, memoryHostKeys, type SpecApp, startSpecApp } from "./spec-kit.js";
import { fileTrustStore } from "./trust.js";

let app: SpecApp;
let root: string;

beforeAll(async () => {
  vi.stubEnv("PARLOR_APP_NAME", "Hello");
  app = await startSpecApp();
  root = await mkdtemp(join(tmpdir(), "pl-"));
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const daemons: ServiceDaemon[] = [];
const clients: ControlClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

async function started(name: string) {
  const paths = hostPaths(join(root, name, ".parlor", "host"));
  const keys = memoryHostKeys();
  const grants = fileGrantStore(paths.grants);
  const trust = fileTrustStore(paths.trust);
  const daemon = createHostDaemon({
    release: {
      version: "1.0.0",
      protocols: { min: 1, max: HOST_PROTOCOL },
      control: 1,
    },
    paths,
    grants,
    keys,
    trust,
    pool: createSessionPool(paths.sessions),
    proxy: createMcpProxy("parlor-host"),
    launcher: acpLauncher(),
    prompter: {
      confirmPairing: async () => false,
      approveDevice: async () => false,
      answerHere: async () => undefined,
      turnStarted: () => undefined,
    },
    policy: DEV_POLICY,
  });
  daemons.push(daemon);
  await daemon.start();
  const control = (await connectControl(paths.control))!;
  clients.push(control);
  return { control, grants, trust, keys };
}

const authorize = async (browser: Browser, pairing: unknown) => {
  const response = await browser.fetch("/_parlor/auth/hosts/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(pairing as object),
      redirectUri: "urn:parlor:ipc",
      decision: "connect",
    }),
  });
  return ((await response.json()) as { code: string }).code;
};

const device = {
  deviceId: "device-app",
  name: "Hello on macOS",
  platform: "tauri",
  signingKey: { kty: "EC", crv: "P-256", x: "xs", y: "ys" },
  presenceKey: {
    format: "es256-raw",
    keyId: "presence-id",
    publicKey: { kty: "EC", crv: "P-256", x: "xp", y: "yp" },
  },
};

describe("the daemon pairing a desktop app over its control socket", () => {
  it("C8: pairs on the user's confirmation, serves the app, and pins the app's own device at pairing", async () => {
    const alice = await app.signUp("Mia");
    const { control, grants, trust, keys } = await started("confirm");
    const begun = await control.send({
      op: "begin_local_pairing",
      appOrigin: app.origin,
    });
    if (!begun.ok) throw new Error(begun.error);
    const finished = await control.send({
      op: "finish_local_pairing",
      appOrigin: app.origin,
      code: await authorize(alice, begun.pairing),
    });
    expect(finished).toEqual({
      ok: true,
      account: "mia@example.com",
      appName: "Hello",
      matchingCode: begun.pairing.matchingCode,
    });
    expect(await grants.get(app.origin)).toBeUndefined();

    expect(
      await control.send({
        op: "confirm_local_pairing",
        appOrigin: app.origin,
        connect: true,
        device,
      }),
    ).toEqual({ ok: true });
    const grant = await grants.get(app.origin);
    expect(grant).toMatchObject({
      appName: "Hello",
      account: { email: "mia@example.com" },
    });
    expect(keys.origins()).toEqual([app.origin]);
    expect(await trust.get(app.origin, "device-app")).toMatchObject({
      deviceId: "device-app",
      name: "Hello on macOS",
      platform: "tauri",
      via: "pairing",
      signingKey: device.signingKey,
      presenceKey: device.presenceKey,
    });

    const status = await control.send({ op: "status" });
    expect(status).toMatchObject({
      ok: true,
      status: { state: "running", apps: [app.origin] },
      grants: [{ appOrigin: app.origin, appName: "Hello", grantId: grant!.grantId }],
    });
  }, 60_000);

  it("refuses to pair an app this computer is already connected to, and touches nothing", async () => {
    const alice = await app.signUp("Ivy");
    const { control, grants, keys } = await started("again");
    const begun = await control.send({
      op: "begin_local_pairing",
      appOrigin: app.origin,
    });
    if (!begun.ok) throw new Error(begun.error);
    await control.send({
      op: "finish_local_pairing",
      appOrigin: app.origin,
      code: await authorize(alice, begun.pairing),
    });
    await control.send({
      op: "confirm_local_pairing",
      appOrigin: app.origin,
      connect: true,
      device,
    });
    const before = await grants.get(app.origin);
    const create = vi.spyOn(keys, "create");

    expect(
      await control.send({ op: "begin_local_pairing", appOrigin: app.origin }),
    ).toEqual({ ok: false, error: "This computer is already connected to Hello." });

    expect(create).not.toHaveBeenCalled();
    expect(await grants.get(app.origin)).toEqual(before);
    expect(keys.origins()).toEqual([app.origin]);
    expect(
      await control.send({
        op: "finish_local_pairing",
        appOrigin: app.origin,
        code: "x",
      }),
    ).toEqual({ ok: false, error: "No pairing was started for this app." });
    expect(await control.send({ op: "status" })).toMatchObject({
      status: { apps: [app.origin] },
    });
  }, 60_000);

  it("pins nothing when the app's device is not whole, and still pairs", async () => {
    const alice = await app.signUp("Noa");
    const { control, trust } = await started("half");
    const begun = await control.send({
      op: "begin_local_pairing",
      appOrigin: app.origin,
    });
    if (!begun.ok) throw new Error(begun.error);
    await control.send({
      op: "finish_local_pairing",
      appOrigin: app.origin,
      code: await authorize(alice, begun.pairing),
    });
    expect(
      await control.send({
        op: "confirm_local_pairing",
        appOrigin: app.origin,
        connect: true,
        device: { deviceId: "device-app" } as never,
      }),
    ).toEqual({ ok: true });
    expect(await trust.get(app.origin, "device-app")).toBeUndefined();
  }, 60_000);

  it("keeps nothing and revokes the grant when the user cancels the native dialog", async () => {
    const alice = await app.signUp("Ola");
    const { control, grants, trust, keys } = await started("cancel");
    const begun = await control.send({
      op: "begin_local_pairing",
      appOrigin: app.origin,
    });
    if (!begun.ok) throw new Error(begun.error);
    await control.send({
      op: "finish_local_pairing",
      appOrigin: app.origin,
      code: await authorize(alice, begun.pairing),
    });
    expect(
      await control.send({
        op: "confirm_local_pairing",
        appOrigin: app.origin,
        connect: false,
        device,
      }),
    ).toEqual({ ok: false, error: "declined_locally" });
    expect(await grants.list()).toEqual([]);
    expect(keys.origins()).toEqual([]);
    expect(await trust.get(app.origin, "device-app")).toBeUndefined();
    const hosts = await alice.fetch("/_parlor/auth/actions/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(((await hosts.json()) as { data: unknown[] }).data).toEqual([]);
  }, 60_000);

  it("answers a finish or confirm with no pairing begun, and a finish with a bad code", async () => {
    const { control } = await started("none");
    expect(
      await control.send({
        op: "finish_local_pairing",
        appOrigin: app.origin,
        code: "x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await control.send({
        op: "confirm_local_pairing",
        appOrigin: app.origin,
        connect: true,
      }),
    ).toMatchObject({ ok: false });
    const begun = await control.send({
      op: "begin_local_pairing",
      appOrigin: app.origin,
    });
    expect(begun).toMatchObject({ ok: true });
    expect(
      await control.send({
        op: "finish_local_pairing",
        appOrigin: app.origin,
        code: "not-a-code",
      }),
    ).toMatchObject({ ok: false });
  }, 60_000);

  it("answers hello with the release it runs", async () => {
    const { control } = await started("hello");
    expect(
      await control.send({
        op: "hello",
        client: {
          kind: "cli",
          release: { version: "0.0.1", protocols: { min: 1, max: 2 }, control: 1 },
        },
      }),
    ).toEqual({
      ok: true,
      release: {
        version: "1.0.0",
        protocols: { min: 1, max: HOST_PROTOCOL },
        control: 1,
      },
    });
  }, 60_000);
});
