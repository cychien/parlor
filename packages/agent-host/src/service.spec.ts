import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  actionFor,
  type AdoptOutcome,
  ensureServiceWith,
  type HostRelease,
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
  readyMs: 20_000,
  pollMs: 50,
  ...overrides,
});

describe("the adopt decision", () => {
  const running = release("1.2.0");
  const table: [string, Parameters<typeof actionFor>[0], ServiceClient, string][] = [
    ["no service", { service: "absent" }, cli("1.0.0"), "spawn_self"],
    ["a daemon without hello", { service: "legacy" }, cli("1.0.0"), "refuse_legacy"],
    [
      "a running service, an older CLI",
      { service: "running", running },
      cli("0.0.1"),
      "use",
    ],
    [
      "a running service, a CLI of the same release",
      { service: "running", running },
      cli("1.2.0"),
      "use",
    ],
    [
      "a running service, a newer CLI",
      { service: "running", running },
      cli("1.10.0"),
      "replace",
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
  it("adopts a service of its own release or a newer one", async () => {
    await startDaemon("1.0.0");
    expect(await ensureServiceWith(quick(), paths, cli("1.0.0"))).toEqual({
      kind: "using",
      running: release("1.0.0"),
    });
    expect(await ensureServiceWith(quick(), paths, cli("0.0.1"))).toEqual({
      kind: "using",
      running: release("1.0.0"),
    });
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
      expect(await ensureServiceWith(quick(), paths, cli("1.0.0"))).toEqual({
        kind: "refused",
        reason: "legacy_service",
      });
    } finally {
      legacy.close();
    }
  });
});

describe("a newer CLI with a service running", () => {
  it("has the old service hand over to it and drain, and starts itself", async () => {
    const old = await startDaemon("1.0.0");
    const start = vi.fn(spawnDaemon("1.1.0"));
    const outcome = await ensureServiceWith(quick({ start }), paths, cli("1.1.0"));
    expect(outcome).toEqual({
      kind: "upgraded",
      from: release("1.0.0"),
      to: release("1.1.0"),
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(await versionRunning()).toBe("1.1.0");
    await old.drained;
  }, 60_000);

  it("is refused a step aside it asks with a release that is not newer", async () => {
    await startDaemon("1.1.0");
    const control = (await connectControl(paths.control))!;
    expect(await control.send({ op: "step_aside", release: release("1.1.0") })).toEqual({
      ok: false,
      error: "downgrade",
    });
    control.close();
    expect(await versionRunning()).toBe("1.1.0");
  }, 30_000);

  async function serviceWithoutStepAside(): Promise<Server> {
    await mkdir(join(paths.root, "run"), { recursive: true });
    const old: Server = createServer((socket) => {
      socket.on("data", (data) => {
        const { op } = JSON.parse(String(data)) as { op: string };
        socket.write(
          `${JSON.stringify(op === "hello" ? { ok: true, release: release("1.0.0") } : { ok: false, error: "Unknown op." })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => old.listen(paths.control, resolve));
    return old;
  }

  it("stops a release from before step_aside itself, then starts", async () => {
    const old = await serviceWithoutStepAside();
    const stopOld = vi.fn(async () => {
      old.closeAllConnections?.();
      await new Promise((resolve) => old.close(resolve));
    });
    const outcome = await ensureServiceWith(
      quick({ start: spawnDaemon("1.1.0"), stopOld }),
      paths,
      cli("1.1.0"),
    );
    expect(stopOld).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "upgraded",
      from: release("1.0.0"),
      to: release("1.1.0"),
    });
    expect(await versionRunning()).toBe("1.1.0");
  }, 60_000);

  it("stops a release from before step_aside by its pid, killing one that ignores SIGTERM", async () => {
    await mkdir(join(paths.root, "run"), { recursive: true });
    const script = join(root, "parlor-host");
    await writeFile(
      script,
      `const net = require("node:net");
process.on("SIGTERM", () => undefined);
net.createServer((socket) => socket.on("data", (data) => {
  const { op } = JSON.parse(String(data));
  socket.write(JSON.stringify(op === "hello" ? { ok: true, release: ${JSON.stringify(release("1.0.0"))} } : { ok: false, error: "Unknown op." }) + "\\n");
})).listen(process.argv[2], () => process.stdout.write("listening\\n"));
`,
    );
    const old = spawn(process.execPath, [script, paths.control, "daemon"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve) => old.stdout.once("data", () => resolve()));
      const outcome = await ensureServiceWith(
        quick({ start: spawnDaemon("1.1.0") }),
        paths,
        cli("1.1.0"),
      );
      expect(outcome).toEqual({
        kind: "upgraded",
        from: release("1.0.0"),
        to: release("1.1.0"),
      });
      expect(old.signalCode).toBe("SIGKILL");
      expect(await versionRunning()).toBe("1.1.0");
    } finally {
      old.kill("SIGKILL");
    }
  }, 60_000);

  it("keeps using an old release that does not stop", async () => {
    const old = await serviceWithoutStepAside();
    try {
      const start = vi.fn(spawnDaemon("1.1.0"));
      const outcome = await ensureServiceWith(
        quick({ start, stopOld: async () => undefined, readyMs: 500 }),
        paths,
        cli("1.1.0"),
      );
      expect(outcome).toEqual({ kind: "using", running: release("1.0.0") });
      expect(start).not.toHaveBeenCalled();
    } finally {
      old.close();
    }
  }, 30_000);
});

describe("no service running", () => {
  it("T6-01: lets two CLIs start at once and starts the service once", async () => {
    const start = vi.fn(spawnDaemon("1.0.0"));
    const deps = quick({ start });
    const outcomes = await Promise.all([
      ensureServiceWith(deps, paths, cli("1.0.0")),
      ensureServiceWith(deps, paths, cli("1.0.0")),
    ]);
    expect(start).toHaveBeenCalledOnce();
    expect(outcomes.map((outcome: AdoptOutcome) => outcome.kind).sort()).toEqual([
      "started",
      "using",
    ]);
  }, 60_000);

  it("hands the service lock's token to the daemon it starts, while it holds that lock", async () => {
    const held: boolean[] = [];
    const start = async (...args: Parameters<NonNullable<ServiceDeps["start"]>>) => {
      held.push(await holdsLock(paths.lock, args[3]));
      await spawnDaemon("1.0.0")(...args);
    };
    await ensureServiceWith(quick({ start }), paths, cli("1.0.0"));
    expect(held).toEqual([true]);
    expect(existsSync(paths.lock)).toBe(false);
  }, 60_000);

  it("a CLI starts the service itself", async () => {
    const start = vi.fn(spawnDaemon("1.0.0"));
    const outcome = await ensureServiceWith(quick({ start }), paths, cli("1.0.0"));
    expect(outcome).toEqual({ kind: "started", release: release("1.0.0") });
    expect(start).toHaveBeenCalledOnce();
    expect(await versionRunning()).toBe("1.0.0");
  }, 60_000);
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
      const control = (await connectControl(paths.control))!;
      expect(await control.send({ op: "step_aside", release: release("1.1.0") })).toEqual(
        { ok: true },
      );
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
    } finally {
      vi.unstubAllEnvs();
      await app.close();
    }
  }, 60_000);
});
