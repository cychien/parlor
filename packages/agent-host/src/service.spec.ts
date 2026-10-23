import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROTOCOL } from "@parlor/chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acpLauncher } from "./acp.js";
import { connectControl } from "./control.js";
import { createHostDaemon, HostAlreadyRunning, type ServiceDaemon } from "./daemon.js";
import { fileGrantStore } from "./grants.js";
import { holdsLock, withFileLock } from "./lock.js";
import { createMcpProxy } from "./mcp-proxy.js";
import { hostPaths, type HostPaths } from "./paths.js";
import { DEV_POLICY } from "./policy.js";
import { createSessionPool } from "./pool.js";
import { RELEASE_PLATFORM, releaseBytes, sha256File } from "./release.js";
import {
  actionFor,
  type AdoptOutcome,
  ensureServiceWith,
  type HostRelease,
  installLoginItem,
  type ServiceClient,
  type ServiceDeps,
} from "./service.js";
import {
  claimedTurn,
  grantFor,
  hostRoutes,
  json,
  memoryHostKeys,
  stubApp,
} from "./spec-kit.js";
import { fileTrustStore } from "./trust.js";

const trusted = vi.hoisted(async () => {
  const crypto = await import("node:crypto");
  const pair = crypto.generateKeyPairSync("ed25519");
  return { pair, publicKey: pair.publicKey.export({ format: "jwk" }).x! };
});

vi.mock("./release.js", async (original) => ({
  ...(await original<typeof import("./release.js")>()),
  RELEASE_KEY: (await trusted).publicKey,
}));

const FAKE = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));
const release = (version: string): HostRelease => ({
  version,
  protocols: { min: 1, max: HOST_PROTOCOL },
  control: 1,
});

let root: string;
let paths: HostPaths;
const daemons: ServiceDaemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ps-"));
  paths = hostPaths(join(root, ".parlor", "host"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function startDaemon(
  version: string,
  options: {
    readonly paths?: HostPaths;
    readonly grants?: boolean;
    readonly lockToken?: string;
  } = {},
): Promise<ServiceDaemon> {
  const at = options.paths ?? paths;
  const daemon = createHostDaemon({
    release: release(version),
    paths: at,
    grants: fileGrantStore(at.grants),
    keys: memoryHostKeys(),
    trust: fileTrustStore(at.trust),
    pool: createSessionPool(at.sessions),
    proxy: createMcpProxy("parlor-host"),
    launcher: acpLauncher(),
    prompter: {
      answerHere: async () => undefined,
      turnStarted: () => undefined,
    },
    policy: DEV_POLICY,
    lockToken: options.lockToken,
  });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

const spawnDaemon =
  (version: string) =>
  async (
    _paths: HostPaths,
    _command: string,
    _args: readonly string[],
    lockToken: string,
  ): Promise<void> => {
    await startDaemon(version, { lockToken });
  };

interface Bundle {
  readonly binary: string;
  readonly signature: string;
}

async function bundle(
  name: string,
  version: string,
  options: { readonly key?: ReturnType<typeof generateKeyPairSync>["privateKey"] } = {},
): Promise<Bundle> {
  const dir = join(root, "bundles", name);
  await mkdir(dir, { recursive: true });
  const binary = join(dir, "parlor-host");
  await writeFile(binary, `binary of ${name} ${version}`, { mode: 0o755 });
  const body = {
    v: 1 as const,
    version,
    platform: RELEASE_PLATFORM,
    sha256: await sha256File(binary),
  };
  const signature = join(dir, "parlor-host.sig");
  await writeFile(
    signature,
    JSON.stringify({
      ...body,
      signature: sign(
        null,
        releaseBytes(body),
        options.key ?? (await trusted).pair.privateKey,
      ).toString("base64url"),
    }),
  );
  return { binary, signature };
}

const sidecar = (version: string, files: Bundle): ServiceClient => ({
  kind: "desktop-sidecar",
  app: "dev.parlor.hello",
  release: release(version),
  binary: files.binary,
  signature: files.signature,
});

const cli = (version: string): ServiceClient => ({
  kind: "cli",
  release: release(version),
});

async function versionRunning(): Promise<string | undefined> {
  const control = await connectControl(paths.control);
  const reply = await control?.send({ op: "status" });
  control?.close();
  return reply?.ok ? (reply.status as { version?: string }).version : undefined;
}

const quick = (overrides: Partial<ServiceDeps> = {}): ServiceDeps => ({
  releaseKey: undefined,
  readyMs: 20_000,
  pollMs: 50,
  ...overrides,
});

async function withTrust(overrides: Partial<ServiceDeps> = {}): Promise<ServiceDeps> {
  return quick({ releaseKey: (await trusted).publicKey, ...overrides });
}

describe("the adopt decision", () => {
  const running = release("1.2.0");
  const files = { binary: "b", signature: "s" };
  const table: [string, Parameters<typeof actionFor>[0], ServiceClient, string][] = [
    [
      "no service, nothing installed, a CLI",
      { service: "absent", installed: false },
      cli("1.0.0"),
      "spawn_self",
    ],
    [
      "no service, nothing installed, an app",
      { service: "absent", installed: false },
      sidecar("1.0.0", files),
      "install_bundled",
    ],
    [
      "no service, one installed, a CLI",
      { service: "absent", installed: true },
      cli("1.0.0"),
      "start_installed",
    ],
    [
      "no service, one installed, an app",
      { service: "absent", installed: true },
      sidecar("9.0.0", files),
      "start_installed",
    ],
    [
      "a daemon without hello",
      { service: "legacy" },
      sidecar("9.0.0", files),
      "refuse_legacy",
    ],
    [
      "a daemon without hello, a CLI",
      { service: "legacy" },
      cli("1.0.0"),
      "refuse_legacy",
    ],
    [
      "a running service, a CLI of any release",
      { service: "running", running },
      cli("0.0.1"),
      "use",
    ],
    [
      "a running service, an app of the same release",
      { service: "running", running },
      sidecar("1.2.0", files),
      "use",
    ],
    [
      "a running service, an older app",
      { service: "running", running },
      sidecar("1.1.9", files),
      "refuse_downgrade",
    ],
    [
      "a running service, a newer app",
      { service: "running", running },
      sidecar("1.10.0", files),
      "hand_over",
    ],
  ];

  it.each(table)("T6-03a: %s -> %s", (_name, situation, client, expected) => {
    expect(actionFor(situation, client).do).toBe(expected);
  });
});

describe("starting a daemon outside ensureService", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => mkdir(paths.root, { recursive: true }));

  it("T6-01: lets exactly one of two daemons started at once bind the control socket", async () => {
    const outcomes = await Promise.allSettled([
      startDaemon("1.0.0"),
      startDaemon("1.0.0"),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(HostAlreadyRunning);
    expect(await versionRunning()).toBe("1.0.0");
  });

  it("waits for the lock an ensureService holds before probing or binding", async () => {
    let started = false;
    await withFileLock(paths.lock, async () => {
      const waiting = startDaemon("1.0.0").then(() => void (started = true));
      await sleep(300);
      expect(started).toBe(false);
      expect(await versionRunning()).toBeUndefined();
      await rm(paths.lock);
      await waiting;
    });
    expect(started).toBe(true);
  });

  it("does not skip the lock for a token that names no held lock", async () => {
    let started = false;
    await withFileLock(paths.lock, async () => {
      const waiting = startDaemon("1.0.0", { lockToken: "forged" }).then(
        () => void (started = true),
      );
      await sleep(300);
      expect(started).toBe(false);
      await rm(paths.lock);
      await waiting;
    });
  });

  it("starts under the lock its parent ensureService holds", async () => {
    await withFileLock(paths.lock, async (lockToken) => {
      await startDaemon("1.0.0", { lockToken });
    });
    expect(await versionRunning()).toBe("1.0.0");
  });

  it("releases the lock once it is bound", async () => {
    await startDaemon("1.0.0");
    expect(existsSync(paths.lock)).toBe(false);
  });
});

describe("a service already running", () => {
  it("T6-03a: refuses a binary signed with another key, and leaves current and the running version alone", async () => {
    await startDaemon("1.0.0");
    const forged = await bundle("forged", "2.0.0", {
      key: generateKeyPairSync("ed25519").privateKey,
    });
    const outcome = await ensureServiceWith(
      await withTrust(),
      paths,
      sidecar("2.0.0", forged),
    );
    expect(outcome).toMatchObject({ kind: "refused", reason: "unsigned" });
    expect(existsSync(paths.current)).toBe(false);
    expect(existsSync(paths.versions)).toBe(false);
    expect(await versionRunning()).toBe("1.0.0");
  }, 30_000);

  it("T6-03a: refuses a correctly signed older release, and leaves current and the running version alone", async () => {
    await startDaemon("1.0.0");
    const older = await bundle("older", "0.9.0");
    const outcome = await ensureServiceWith(
      await withTrust(),
      paths,
      sidecar("0.9.0", older),
    );
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "downgrade",
      running: { version: "1.0.0" },
    });
    expect(existsSync(paths.current)).toBe(false);
    expect(await versionRunning()).toBe("1.0.0");
  }, 30_000);

  it("T6-03a: has the running service refuse a release that is not newer even when the client asks for it", async () => {
    await startDaemon("1.0.0");
    const same = await bundle("same", "1.0.0");
    const control = (await connectControl(paths.control))!;
    expect(await control.send({ op: "handover", ...same })).toEqual({
      ok: false,
      error: "downgrade",
    });
    const forged = await bundle("forged-handover", "3.0.0", {
      key: generateKeyPairSync("ed25519").privateKey,
    });
    expect(await control.send({ op: "handover", ...forged })).toEqual({
      ok: false,
      error: "unsigned",
    });
    control.close();
    expect(await versionRunning()).toBe("1.0.0");
  }, 30_000);

  it("adopts a service of the same release, and any CLI", async () => {
    await startDaemon("1.0.0");
    const same = await bundle("same-adopt", "1.0.0");
    expect(
      await ensureServiceWith(await withTrust(), paths, sidecar("1.0.0", same)),
    ).toEqual({
      kind: "using",
      running: release("1.0.0"),
    });
    expect(await ensureServiceWith(await withTrust(), paths, cli("0.0.1"))).toMatchObject(
      {
        kind: "using",
      },
    );
  }, 30_000);

  it("refuses a daemon that has no hello op, as a legacy service", async () => {
    await mkdir(join(paths.root, "run"), { recursive: true });
    const legacy: Server = createServer((socket) => {
      socket.on("data", () =>
        socket.write(`${JSON.stringify({ ok: false, error: "Unknown op." })}\n`),
      );
    });
    await new Promise<void>((resolve) => legacy.listen(paths.control, resolve));
    try {
      expect(await ensureServiceWith(await withTrust(), paths, cli("1.0.0"))).toEqual({
        kind: "refused",
        reason: "legacy_service",
      });
    } finally {
      legacy.close();
    }
  });

  it("T6-01: upgrades to a newer signed release: installs it, repoints current, hands over, and starts the new service", async () => {
    const old = await startDaemon("1.0.0");
    const next = await bundle("next", "1.1.0");
    const outcome = await ensureServiceWith(
      await withTrust({ start: spawnDaemon("1.1.0") }),
      paths,
      sidecar("1.1.0", next),
    );
    expect(outcome).toEqual({
      kind: "upgraded",
      from: release("1.0.0"),
      to: release("1.1.0"),
    });
    expect(await readlink(paths.current)).toBe(join("versions", "1.1.0"));
    expect(await realpath(join(paths.current, "parlor-host"))).toBe(
      await realpath(join(paths.versions, "1.1.0", "parlor-host")),
    );
    expect(readFileSync(join(paths.versions, "1.1.0", "parlor-host"), "utf8")).toBe(
      "binary of next 1.1.0",
    );
    expect(existsSync(join(paths.versions, "1.1.0", "parlor-host.sig"))).toBe(true);
    expect(await versionRunning()).toBe("1.1.0");
    await old.drained;
    const plist = readFileSync(paths.launchAgent, "utf8");
    expect(plist).toContain(join(paths.current, "parlor-host"));
  }, 60_000);
});

describe("no service running", () => {
  it("T6-01: installs the bundled release from its own signature, links current, writes the login item and starts it", async () => {
    const files = await bundle("first", "1.0.0");
    const outcome = await ensureServiceWith(
      await withTrust({ start: spawnDaemon("1.0.0") }),
      paths,
      sidecar("1.0.0", files),
    );
    expect(outcome).toEqual({ kind: "installed", release: release("1.0.0") });
    expect(await readlink(paths.current)).toBe(join("versions", "1.0.0"));
    expect(await readdir(paths.versions)).toEqual(["1.0.0"]);
    const plist = readFileSync(paths.launchAgent, "utf8");
    expect(plist).toContain("<string>dev.parlor.host</string>");
    expect(plist).toContain(`<string>${join(paths.current, "parlor-host")}</string>`);
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).not.toContain(root + "/bundles");
  }, 60_000);

  it("T6-03a: installs nothing when the bundled binary is not signed by the release key", async () => {
    const forged = await bundle("forged-first", "1.0.0", {
      key: generateKeyPairSync("ed25519").privateKey,
    });
    const start = vi.fn(async () => undefined);
    const outcome = await ensureServiceWith(
      await withTrust({ start }),
      paths,
      sidecar("1.0.0", forged),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "unsigned" });
    expect(existsSync(paths.versions)).toBe(false);
    expect(existsSync(paths.launchAgent)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("T6-03a: installs nothing when the binary was changed after it was signed", async () => {
    const files = await bundle("tampered", "1.0.0");
    await writeFile(files.binary, "something else");
    const outcome = await ensureServiceWith(
      await withTrust({ start: vi.fn(async () => undefined) }),
      paths,
      sidecar("1.0.0", files),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "unsigned" });
    expect(existsSync(paths.current)).toBe(false);
  });

  it("T6-03a: installs nothing when the signature names another version than the bundle claims", async () => {
    const files = await bundle("relabeled", "1.0.0");
    const outcome = await ensureServiceWith(
      await withTrust({ start: vi.fn(async () => undefined) }),
      paths,
      sidecar("5.0.0", files),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "unsigned" });
  });

  it("T6-01: lets two apps start at once and starts the service once", async () => {
    const files = await bundle("race", "1.0.0");
    const start = vi.fn(spawnDaemon("1.0.0"));
    const deps = await withTrust({ start });
    const outcomes = await Promise.all([
      ensureServiceWith(deps, paths, sidecar("1.0.0", files)),
      ensureServiceWith(deps, paths, sidecar("1.0.0", files)),
    ]);
    expect(start).toHaveBeenCalledOnce();
    expect(outcomes.map((outcome: AdoptOutcome) => outcome.kind).sort()).toEqual([
      "installed",
      "using",
    ]);
  }, 60_000);

  it("converges on the same state when an earlier install stopped half way", async () => {
    const files = await bundle("again", "1.0.0");
    await mkdir(join(paths.versions, `.1.0.0.tmp-${process.pid}`), { recursive: true });
    await writeFile(
      join(paths.versions, `.1.0.0.tmp-${process.pid}`, "parlor-host"),
      "partial",
    );
    const deps = await withTrust({
      start: spawnDaemon("1.0.0"),
    });
    expect(await ensureServiceWith(deps, paths, sidecar("1.0.0", files))).toMatchObject({
      kind: "installed",
    });
    expect(readFileSync(join(paths.versions, "1.0.0", "parlor-host"), "utf8")).toBe(
      "binary of again 1.0.0",
    );
    expect(
      createHash("sha256")
        .update(readFileSync(join(paths.versions, "1.0.0", "parlor-host")))
        .digest("hex"),
    ).toBe(await sha256File(files.binary));
  }, 60_000);

  it("starts an installed release first, then lets a newer bundle take over from it", async () => {
    const first = await bundle("installed-1", "1.0.0");
    const deps = await withTrust({
      start: spawnDaemon("1.0.0"),
    });
    await ensureServiceWith(deps, paths, sidecar("1.0.0", first));
    await daemons.shift()!.stop();
    expect(await versionRunning()).toBeUndefined();
    const second = await bundle("installed-2", "1.1.0");
    const starts: string[] = [];
    const outcome = await ensureServiceWith(
      await withTrust({
        start: async (...args) => {
          const version = starts.length === 0 ? "1.0.0" : "1.1.0";
          starts.push(version);
          await spawnDaemon(version)(...args);
        },
      }),
      paths,
      sidecar("1.1.0", second),
    );
    expect(starts).toEqual(["1.0.0", "1.1.0"]);
    expect(outcome).toMatchObject({ kind: "upgraded", to: { version: "1.1.0" } });
  }, 90_000);

  it("hands the service lock's token to the daemon it starts, while it holds that lock", async () => {
    const held: boolean[] = [];
    const start = async (...args: Parameters<NonNullable<ServiceDeps["start"]>>) => {
      held.push(await holdsLock(paths.lock, args[3]));
      await spawnDaemon("1.0.0")(...args);
    };
    await ensureServiceWith(await withTrust({ start }), paths, cli("1.0.0"));
    expect(held).toEqual([true]);
    expect(existsSync(paths.lock)).toBe(false);
  }, 60_000);

  it("a CLI starts the service itself and installs nothing", async () => {
    const start = vi.fn(spawnDaemon("1.0.0"));
    const outcome = await ensureServiceWith(
      await withTrust({ start }),
      paths,
      cli("1.0.0"),
    );
    expect(outcome).toEqual({ kind: "installed", release: release("1.0.0") });
    expect(existsSync(paths.versions)).toBe(false);
    expect(existsSync(paths.launchAgent)).toBe(false);
  }, 60_000);
});

describe("installLoginItem", () => {
  it("writes a LaunchAgent that restarts the service only after a crash", async () => {
    await installLoginItem(paths);
    const plist = readFileSync(paths.launchAgent, "utf8");
    expect(plist).toContain("<string>dev.parlor.host</string>");
    expect(plist).toContain(`<string>${join(paths.current, "parlor-host")}</string>`);
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
  });
});

describe("handing over with a turn running", () => {
  it("T6-02: finishes the running turn on the old process, which neither reports offline nor listens any more", async () => {
    const script = join(root, "script.json");
    await writeFile(
      script,
      JSON.stringify({
        fallback: "echo",
        steps: {
          slow: [
            {
              kind: "reply",
              chunks: Array.from({ length: 30 }, () => "slow "),
              perSecond: 20,
            },
          ],
        },
      }),
    );
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      paths.agents,
      JSON.stringify([
        {
          id: "fake-a",
          name: "Fake A",
          launch: { kind: "native", command: process.execPath, args: [FAKE, script] },
          binary: process.execPath,
        },
      ]),
    );
    vi.stubEnv("FAKE_AGENT_LOG", join(root, "agent.log"));
    const routes = hostRoutes({ wake: true });
    let claims = 0;
    const app = await stubApp((request, body, response) => {
      const path = new URL(request.url ?? "/", "http://stub").pathname;
      if (path.endsWith("/hostClaim")) {
        claims += 1;
        if (claims === 1) {
          return (
            json(response, {
              data: claimedTurn(
                "u1",
                "fake-a",
                "<parlor-context>x</parlor-context>",
                "slow",
              ),
              tags: [],
            }),
            true
          );
        }
      }
      return routes(request, body, response);
    });
    const keys = memoryHostKeys();
    const grants = fileGrantStore(paths.grants);
    const old = createHostDaemon({
      release: release("1.0.0"),
      paths,
      grants,
      keys,
      trust: fileTrustStore(paths.trust),
      pool: createSessionPool(paths.sessions),
      proxy: createMcpProxy("parlor-host"),
      launcher: acpLauncher(),
      prompter: {
        answerHere: async () => undefined,
        turnStarted: () => undefined,
      },
      policy: DEV_POLICY,
    });
    daemons.push(old);
    try {
      await old.start();
      const grant = grantFor(app.origin, "Hello", join(root, "Parlor", "hello"));
      await (await keys.create(app.origin)).keep(grant.grantId);
      await grants.save(grant);
      await old.connect(app.origin);
      await vi.waitFor(
        () =>
          expect(app.seen.some((seen) => seen.path.endsWith("/hostClaim"))).toBe(true),
        { timeout: 15_000 },
      );
      const next = await bundle("drain-next", "1.1.0");
      const control = (await connectControl(paths.control))!;
      expect(await control.send({ op: "handover", ...next })).toEqual({ ok: true });
      control.close();
      expect(await connectControl(paths.control)).toBeUndefined();
      expect(app.seen.some((seen) => seen.path.endsWith("/hostFinish"))).toBe(false);

      await old.drained;
      const finish = app.seen.find((seen) => seen.path.endsWith("/hostFinish"));
      expect(JSON.parse(finish!.body)).toMatchObject({
        turnId: "u1",
        outcome: { state: "done" },
      });
      const reports = app.seen
        .filter((seen) => seen.path.endsWith("/hostReport"))
        .map((seen) => (JSON.parse(seen.body) as { online: boolean }).online);
      expect(reports).not.toContain(false);
      expect(await readlink(paths.current)).toBe(join("versions", "1.1.0"));
    } finally {
      vi.unstubAllEnvs();
      await app.close();
    }
  }, 60_000);
});
