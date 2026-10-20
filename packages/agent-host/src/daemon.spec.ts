import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
import { DEV_POLICY } from "./policy.js";
import { createSessionPool } from "./pool.js";
import { memoryHostKeys } from "./spec-kit.js";

const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));

interface StubApp {
  readonly origin: string;
  readonly seen: {
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }[];
  close(): Promise<void>;
}

type Route = (
  request: IncomingMessage,
  body: string,
  response: ServerResponse,
) => boolean;

async function stubApp(route: Route): Promise<StubApp> {
  const seen: StubApp["seen"][number][] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://stub").pathname;
      seen.push({ method: request.method ?? "GET", path, body });
      if (!route(request, body, response)) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const json = (response: ServerResponse, value: unknown, status = 200) =>
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));

const welcome = {
  id: "h",
  accepted: true,
  protocol: HOST_PROTOCOL,
  leaseMs: 60_000,
  heartbeatMs: 30_000,
};

function hostRoutes(options: {
  readonly wake: boolean;
  readonly turn?: () => unknown;
}): Route {
  let claimed = false;
  return (request, body, response) => {
    const path = new URL(request.url ?? "/", "http://stub").pathname;
    const action = path.startsWith("/_parlor/chat/actions/")
      ? path.split("/").at(-1)
      : undefined;
    if (action === "hostHello")
      return (json(response, { data: welcome, tags: [] }), true);
    if (action === "hostClaim") {
      if (options.turn && !claimed) {
        claimed = true;
        return (json(response, { data: options.turn(), tags: [] }), true);
      }
      return (
        json(response, { error: { code: "not_found", message: "No turn." } }, 404), true
      );
    }
    if (action === "hostSignals") return (json(response, { data: [], tags: [] }), true);
    if (action) {
      return (
        json(response, {
          data: {
            id: "t1",
            leaseUntil: Date.now() + 60_000,
            token: { token: "turn-2", expiresAt: Date.now() + 60_000 },
          },
          tags: [],
        }),
        true
      );
    }
    if (path === "/_parlor/sync/token") {
      return (
        json(response, {
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2_000,
        }),
        true
      );
    }
    if (path === "/_parlor/sync/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: handshake\ndata: ${JSON.stringify({ capabilities: [], keepAliveMs: 10_000 })}\n\n`,
      );
      if (options.wake) {
        const events = [{ version: 1, id: "e1", tags: [["parlor_chat", "t1"]] }];
        response.write(
          `event: message\ndata: ${JSON.stringify({ events, cursor: "1.e1" })}\n\n`,
        );
      }
      return true;
    }
    if (path === "/_parlor/mcp") {
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) return (response.writeHead(202).end(), true);
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : { content: [{ type: "text", text: "[]" }] };
      return (json(response, { jsonrpc: "2.0", id: message.id, result }), true);
    }
    return false;
  };
}

const grantFor = (origin: string, name: string, workspace: string): AppGrant => ({
  appOrigin: origin,
  appName: name,
  grantId: asId("grant", `host:${name}`),
  hostId: asId("host", `h-${name}`),
  account: { userId: asId("user", "alice"), name: "Alice", email: "alice@example.com" },
  workspace,
  createdAt: 1,
});

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
    const turn = (origin: string) => () => ({
      id: "t1",
      turnId: "u1",
      agent: { hostId: "h-A", agentId: "fake" },
      clientId: "tab",
      prompt: {
        id: "p1",
        threadId: "t1",
        turnId: "u1",
        seq: 1,
        at: Date.now(),
        author: "user",
        kind: "prompt",
        body: { text: "probe", agent: { hostId: "h-A", agentId: "fake" } },
      },
      device: undefined,
      context: `<parlor-context>${origin}</parlor-context>`,
      token: { token: "turn-1", expiresAt: Date.now() + 60_000 },
      leaseUntil: Date.now() + 60_000,
    });
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
