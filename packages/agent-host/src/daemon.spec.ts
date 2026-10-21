import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROTOCOL } from "@parlor/chat";
import { asId } from "@parlor/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { acpLauncher } from "./acp.js";
import { createHostDaemon } from "./daemon.js";
import { type AppGrant, fileGrantStore, keychainHostKeys } from "./grants.js";
import { createMcpProxy } from "./mcp-proxy.js";
import { hostPaths } from "./paths.js";
import { DEFAULT_POLICY, DEV_POLICY } from "./policy.js";
import { createSessionPool } from "./pool.js";
import {
  claimedTurn,
  grantFor,
  hostRoutes,
  json,
  memoryHostKeys,
  type StubApp,
  stubApp,
} from "./spec-kit.js";
import { fileTrustStore } from "./trust.js";

const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));

describe("the host daemon", () => {
  let home: string;
  const apps: StubApp[] = [];
  let daemon: ChildProcess | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pd-"));
  });

  afterAll(async () => {
    daemon?.kill("SIGTERM");
    if (daemon && daemon.exitCode === null) {
      await new Promise((resolve) => daemon!.once("exit", resolve));
    }
    await Promise.all(apps.map((app) => app.close()));
    const keychain = join(home, "Library", "Keychains", "login.keychain-db");
    execFileSync("security", ["delete-keychain", keychain], {
      env: { ...process.env, HOME: home },
    });
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("T4-03: listens on no TCP or UDP socket, only its two 0600 unix sockets", async () => {
    const paths = hostPaths(join(home, ".parlor", "host"));
    const script = join(home, "script.json");
    await writeFile(
      script,
      JSON.stringify({
        steps: {
          probe: [
            { kind: "call_app", tool: "listTasks", input: {} },
            { kind: "wait_for_cancel" },
          ],
        },
      }),
    );
    mkdirSync(join(paths.root), { recursive: true });
    await writeFile(
      paths.policy,
      JSON.stringify({ deviceApproval: "off", answers: "off" }),
    );
    await writeFile(
      paths.agents,
      JSON.stringify([
        {
          id: "fake",
          name: "Fake agent",
          launch: { kind: "native", command: process.execPath, args: [FAKE, script] },
          binary: process.execPath,
        },
      ]),
    );
    const turn = (origin: string) => () =>
      claimedTurn("u1", "fake", `<parlor-context>${origin}</parlor-context>`, "probe");
    const a = await stubApp(hostRoutes({ wake: true, turn: turn("A") }));
    const b = await stubApp(hostRoutes({ wake: false }));
    apps.push(a, b);

    vi.stubEnv("HOME", home);
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    execFileSync(
      "security",
      [
        "create-keychain",
        "-p",
        "",
        join(home, "Library", "Keychains", "login.keychain-db"),
      ],
      {
        env: { ...process.env, HOME: home },
      },
    );
    const keys = keychainHostKeys("dev.parlor.host");
    const grants = fileGrantStore(paths.grants);
    for (const [app, name] of [
      [a, "A"],
      [b, "B"],
    ] as const) {
      await (await keys.create(app.origin)).keep(asId("grant", `host:${name}`));
      await grants.save(grantFor(app.origin, name, join(home, "Parlor", name)));
    }

    daemon = spawn(process.execPath, [BIN, "daemon"], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await vi.waitFor(
      () =>
        expect(
          a.seen.some(
            (seen) => seen.path === "/_parlor/mcp" && seen.body.includes("tools/call"),
          ),
        ).toBe(true),
      { timeout: 30_000, interval: 200 },
    );
    expect(b.seen.some((seen) => seen.path.endsWith("/hostHello"))).toBe(true);

    const proxyChild = Number(
      execFileSync(
        "pgrep",
        ["-f", `${join(paths.root, "bin", "parlor-host")} mcp-proxy`],
        {
          encoding: "utf8",
        },
      ).trim(),
    );
    expect(execFileSync("lsof", ["-t", paths.control], { encoding: "utf8" }).trim()).toBe(
      String(daemon.pid),
    );
    expect(proxyChild).toBeDefined();

    for (const pid of [daemon.pid!, proxyChild!]) {
      let inet = "";
      try {
        inet = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-i"], {
          encoding: "utf8",
        });
      } catch {
        inet = "";
      }
      expect(inet).not.toMatch(/LISTEN/);
      expect(inet).not.toMatch(/\bUDP\b/);
    }
    const unix = execFileSync("lsof", ["-nP", "-a", "-p", String(daemon.pid), "-U"], {
      encoding: "utf8",
    });
    const bound = [...unix.matchAll(/\s(\/\S+\.sock)\s*$/gm)].map((match) => match[1]);
    expect(new Set(bound)).toEqual(new Set([paths.control, paths.proxy]));
    for (const socket of [paths.control, paths.proxy]) {
      expect((await stat(socket)).mode & 0o777).toBe(0o600);
    }
  }, 60_000);
});

describe("an app the host cannot speak to", () => {
  it("T4-01: shows the update message locally and leaves the link down", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-"));
    const refused = {
      id: "h",
      accepted: false,
      reason: "host_too_old",
      protocols: { min: 2, max: 2 },
    };
    const app = await stubApp((request, _body, response) =>
      request.url?.endsWith("/hostHello")
        ? (json(response, { data: refused, tags: [] }), true)
        : false,
    );
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const keys = memoryHostKeys();
    await (await keys.create(app.origin)).keep(asId("grant", "host:H"));
    const paths = hostPaths(join(root, ".parlor", "host"));
    const grants = fileGrantStore(paths.grants);
    await grants.save(grantFor(app.origin, "Hello", join(root, "Parlor", "hello")));
    const host = createHostDaemon({
      release: {
        version: "0.0.0",
        protocols: { min: 1, max: HOST_PROTOCOL },
        control: 1,
      },
      paths,
      grants,
      keys,
      trust: fileTrustStore(paths.trust),
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
    try {
      await host.start();
      await expect(host.connect(app.origin)).rejects.toThrow(
        "Update Parlor Host to use Hello",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const written = output.mock.calls.map((call) => String(call[0])).join("");
      expect(written).toContain("Update Parlor Host to use Hello");
      expect(app.seen.map((seen) => seen.path)).toEqual([
        "/_parlor/chat/actions/hostHello",
      ]);
    } finally {
      output.mockRestore();
      await host.stop();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("disconnecting through the daemon", () => {
  it("T4-12: a revoke the app refuses keeps the link, the grant and the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-"));
    let revokeStatus = 500;
    const routes = hostRoutes({ wake: false });
    const app = await stubApp((request, body, response) =>
      request.url === "/_parlor/auth/hosts/revoke"
        ? (json(response, {}, revokeStatus), true)
        : routes(request, body, response),
    );
    const keys = memoryHostKeys();
    await (await keys.create(app.origin)).keep(asId("grant", "host:Hello"));
    const paths = hostPaths(join(root, ".parlor", "host"));
    const grants = fileGrantStore(paths.grants);
    await grants.save(grantFor(app.origin, "Hello", join(root, "Parlor", "hello")));
    const host = createHostDaemon({
      release: {
        version: "0.0.0",
        protocols: { min: 1, max: HOST_PROTOCOL },
        control: 1,
      },
      paths,
      grants,
      keys,
      trust: fileTrustStore(paths.trust),
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
    try {
      await host.start();
      await host.connect(app.origin);
      await expect(host.disconnect(app.origin)).rejects.toThrow(
        "Hello did not disconnect this computer: it answered HTTP 500.",
      );
      expect((await grants.list()).map((grant) => grant.appOrigin)).toEqual([app.origin]);
      expect(keys.origins()).toEqual([app.origin]);
      const reports = app.seen.filter((seen) => seen.path.endsWith("/hostReport")).length;
      await host.connect(app.origin);
      expect(app.seen.filter((seen) => seen.path.endsWith("/hostReport")).length).toBe(
        reports + 1,
      );

      revokeStatus = 200;
      await host.disconnect(app.origin);
      expect(await grants.list()).toEqual([]);
      expect(keys.origins()).toEqual([]);
    } finally {
      await host.stop();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("T4-15: a session remembered under one grant is never resumed under the next", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-"));
    const agentLog = join(root, "agent.log");
    vi.stubEnv("FAKE_AGENT_LOG", agentLog);
    const claims: (() => unknown)[] = [];
    const routes = hostRoutes({ wake: true });
    const app = await stubApp((request, body, response) => {
      if (request.url === "/_parlor/auth/hosts/revoke") return (json(response, {}), true);
      const next = request.url?.endsWith("/hostClaim") ? claims.shift() : undefined;
      if (next) return (json(response, { data: next(), tags: [] }), true);
      return routes(request, body, response);
    });
    const finished = () =>
      app.seen.filter((seen) => seen.path.endsWith("/hostFinish")).length;
    const remembered = () =>
      existsSync(paths.sessions)
        ? Object.keys(JSON.parse(readFileSync(paths.sessions, "utf8")) as object)
        : [];
    const received = () =>
      readFileSync(agentLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; text?: string });

    const paths = hostPaths(join(root, ".parlor", "host"));
    const script = join(root, "script.json");
    await writeFile(
      script,
      JSON.stringify({ fallback: "echo", advertise: { resume: true }, steps: {} }),
    );
    mkdirSync(paths.root, { recursive: true });
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
    const workspace = join(root, "Parlor", "hello");
    const alice = grantFor(app.origin, "Hello", workspace);
    const bob: AppGrant = {
      ...alice,
      grantId: asId("grant", "host:Bob"),
      account: { userId: asId("user", "bob"), name: "Bob", email: "bob@example.com" },
    };
    const keys = memoryHostKeys();
    const grants = fileGrantStore(paths.grants);
    const host = createHostDaemon({
      release: {
        version: "0.0.0",
        protocols: { min: 1, max: HOST_PROTOCOL },
        control: 1,
      },
      paths,
      grants,
      keys,
      trust: fileTrustStore(paths.trust),
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
    try {
      await host.start();
      await (await keys.create(app.origin)).keep(alice.grantId);
      await grants.save(alice);
      claims.push(() =>
        claimedTurn("u-alice", "fake-a", "<parlor-context>Alice</parlor-context>", "hi"),
      );
      await host.connect(app.origin);
      await vi.waitFor(() => expect(finished()).toBe(1), { timeout: 15_000 });
      await vi.waitFor(() => expect(remembered()).toHaveLength(1));

      await host.disconnect(app.origin);
      expect(remembered()).toEqual([]);

      await (await keys.create(app.origin)).keep(bob.grantId);
      await grants.save(bob);
      claims.push(() =>
        claimedTurn("u-bob", "fake-a", "<parlor-context>Bob</parlor-context>", "hi"),
      );
      await host.connect(app.origin);
      await vi.waitFor(() => expect(finished()).toBe(2), { timeout: 15_000 });

      const methods = received().map((entry) => entry.method);
      expect(methods).not.toContain("session/resume");
      expect(methods.filter((method) => method === "session/new")).toHaveLength(2);
      const prompts = received().filter((entry) => entry.method === "session/prompt");
      expect(prompts.map((entry) => entry.text!.split("\n\n")[0])).toEqual([
        "<parlor-context>Alice</parlor-context>",
        "<parlor-context>Bob</parlor-context>",
      ]);
    } finally {
      await host.stop();
      await app.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("what the daemon enforces on a grant's turns", () => {
  it("runs a production grant under the default policy overlaid by policy.json at each turn, and a dev grant under the dev policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "pe-"));
    const paths = hostPaths(join(root, ".parlor", "host"));
    const withClaim = (turnId: string) => {
      const routes = hostRoutes({ wake: true });
      let pending: (() => unknown) | undefined = () =>
        claimedTurn(turnId, "ghost", "<parlor-context>x</parlor-context>", "hi");
      return stubApp((request, body, response) => {
        if (request.url === "/_parlor/auth/hosts/revoke")
          return (json(response, {}), true);
        if (request.url?.endsWith("/hostClaim") && pending) {
          const turn = pending;
          pending = undefined;
          return (json(response, { data: turn(), tags: [] }), true);
        }
        return routes(request, body, response);
      });
    };
    const [first, second, dev] = await Promise.all([
      withClaim("u-first"),
      withClaim("u-second"),
      withClaim("u-dev"),
    ]);
    const outcomeOf = (app: StubApp) => {
      const finish = app.seen.find((seen) => seen.path.endsWith("/hostFinish"));
      return finish
        ? (JSON.parse(finish.body) as { outcome: unknown }).outcome
        : undefined;
    };
    const keys = memoryHostKeys();
    const grants = fileGrantStore(paths.grants);
    const trust = fileTrustStore(paths.trust);
    const host = createHostDaemon({
      release: {
        version: "0.0.0",
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
      policy: DEFAULT_POLICY,
    });
    const grantOf = (app: StubApp, name: string): AppGrant => ({
      ...grantFor(app.origin, name, join(root, "Parlor", name)),
    });
    try {
      for (const [app, name] of [
        [first, "First"],
        [dev, "Dev"],
      ] as const) {
        await (await keys.create(app.origin)).keep(asId("grant", `host:${name}`));
      }
      await grants.save(grantOf(first, "First"));
      await grants.save({ ...grantOf(dev, "Dev"), dev: true });
      await host.start();
      await vi.waitFor(() => expect(outcomeOf(first)).toBeDefined(), { timeout: 15_000 });
      await vi.waitFor(() => expect(outcomeOf(dev)).toBeDefined(), { timeout: 15_000 });
      expect(outcomeOf(first)).toEqual({ state: "failed", reason: "device_rejected" });
      expect(outcomeOf(dev)).toEqual({ state: "failed", reason: "agent_unavailable" });

      await writeFile(paths.policy, JSON.stringify({ deviceApproval: "off" }));
      await (await keys.create(second.origin)).keep(asId("grant", "host:Second"));
      await grants.save(grantOf(second, "Second"));
      await host.connect(second.origin);
      await vi.waitFor(() => expect(outcomeOf(second)).toBeDefined(), {
        timeout: 15_000,
      });
      expect(outcomeOf(second)).toEqual({ state: "failed", reason: "agent_unavailable" });

      await trust.pin(first.origin, {
        deviceId: asId("device", "device-1"),
        signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        name: "Chrome",
        platform: "web",
        approvedAt: 1,
        via: "local",
      });
      await trust.pin(second.origin, {
        deviceId: asId("device", "device-1"),
        signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        name: "Chrome",
        platform: "web",
        approvedAt: 1,
        via: "local",
      });
      await host.disconnect(first.origin);
      expect(await trust.get(first.origin, "device-1")).toBeUndefined();
      expect(await trust.get(second.origin, "device-1")).toBeDefined();
    } finally {
      await host.stop();
      await Promise.all([first.close(), second.close(), dev.close()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
