import { spawn } from "node:child_process";
import { mkdtemp, open as openFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineCommand, runMain } from "citty";

import type { AppGrant, GrantStore } from "./grants.js";
import { printable } from "./prompter.js";

const KEYCHAIN_SERVICE = "dev.parlor.host";
const DAEMON_READY_MS = 15_000;

const { version } = createRequire(import.meta.url)("../package.json") as {
  readonly version: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Aborts on the first SIGINT or SIGTERM; a second one gets the default handling. */
function shutdownSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return controller.signal;
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function fail(message: string): void {
  process.stderr.write(`${printable(message)}\n`);
  process.exitCode = 1;
}

async function host() {
  const [
    { acpLauncher },
    { HOST_PROTOCOL },
    { CONTROL_PROTOCOL, connectControl },
    { createHostDaemon },
    { fileGrantStore, keychainHostKeys },
    { createMcpProxy },
    { hostPaths },
    { DEV_POLICY },
    { createSessionPool },
    { terminalPrompter },
    { revokeGrant },
  ] = await Promise.all([
    import("./acp.js"),
    import("@parlor/chat"),
    import("./control.js"),
    import("./daemon.js"),
    import("./grants.js"),
    import("./mcp-proxy.js"),
    import("./paths.js"),
    import("./policy.js"),
    import("./pool.js"),
    import("./prompter.js"),
    import("./revoke.js"),
  ]);
  const POLICY_UNTIL_DEVICE_TRUST = DEV_POLICY;
  type Paths = ReturnType<typeof hostPaths>;
  type Grants = ReturnType<typeof fileGrantStore>;
  const daemonFor = (paths: Paths, grants: Grants) =>
    createHostDaemon({
      release: {
        version,
        protocols: { min: 1, max: HOST_PROTOCOL },
        control: CONTROL_PROTOCOL,
      },
      paths,
      grants,
      keys: keychainHostKeys(KEYCHAIN_SERVICE),
      pool: createSessionPool(paths.sessions),
      proxy: createMcpProxy("parlor-host"),
      launcher: acpLauncher(),
      prompter: terminalPrompter(),
      policy: POLICY_UNTIL_DEVICE_TRUST,
    });
  const ensureDaemon = async (paths: Paths) => {
    const running = await connectControl(paths.control);
    if (running) return running;
    await mkdir(join(paths.root, "logs"), { recursive: true, mode: 0o700 });
    const output = await openFile(join(paths.root, "logs", "daemon.out"), "a", 0o600);
    const child = spawn(process.execPath, [process.argv[1]!, "daemon"], {
      cwd: paths.root,
      detached: true,
      stdio: ["ignore", output.fd, output.fd],
      env: process.env,
    });
    child.unref();
    await output.close();
    for (const deadline = Date.now() + DAEMON_READY_MS; Date.now() < deadline;) {
      const client = await connectControl(paths.control);
      if (client) return client;
      await sleep(100);
    }
    throw new Error(
      `Parlor Host did not start; see ${join(paths.root, "logs", "daemon.out")}.`,
    );
  };
  const disconnectFrom = async (origin: string) => {
    const paths = hostPaths();
    const client = await connectControl(paths.control);
    if (client) {
      const reply = await client.send({ op: "disconnect", appOrigin: origin });
      client.close();
      if (!reply.ok) throw new Error(reply.error);
      return;
    }
    const grants = fileGrantStore(paths.grants);
    const grant = await grants.get(origin);
    if (!grant) throw new Error(`This computer is not connected to ${origin}.`);
    const keys = keychainHostKeys(KEYCHAIN_SERVICE);
    await revokeGrant({
      appOrigin: origin,
      appName: grant.appName,
      assert: (request) => keys.assert(origin, request),
    });
    await grants.remove(origin);
    await keys.remove(origin);
  };
  return {
    connectControl,
    daemonFor,
    disconnectFrom,
    ensureDaemon,
    fileGrantStore,
    hostPaths,
    keychainHostKeys,
    terminalPrompter,
  };
}

const connect = defineCommand({
  meta: { name: "connect", description: "Connect this computer to a Parlor app" },
  args: { url: { type: "positional", required: true, description: "The app's URL" } },
  async run({ args }) {
    const [kit, { pair, UnrevokedGrant }, { computerName, platformName }] =
      await Promise.all([host(), import("./pairing.js"), import("./naming.js")]);
    const origin = new URL(args.url).origin;
    const paths = kit.hostPaths();
    const grants = kit.fileGrantStore(paths.grants);
    let grant = await grants.get(origin);
    if (grant?.declined) {
      try {
        await kit.disconnectFrom(origin);
      } catch (error) {
        fail(errorText(error));
        return;
      }
      grant = undefined;
    }
    if (!grant) {
      let outcome: Awaited<ReturnType<typeof pair>>;
      try {
        outcome = await pair({
          appOrigin: origin,
          hostName: computerName(),
          platform: platformName(),
          keys: kit.keychainHostKeys(KEYCHAIN_SERVICE),
          prompter: kit.terminalPrompter(),
          workspaceRoot: paths.workspaces,
          channel: {
            kind: "browser",
            open: async (url) => {
              process.stdout.write(
                `Open this page in your browser to connect this computer:\n${url}\n`,
              );
              spawn("open", [url], { stdio: "ignore", detached: true })
                .on("error", () => undefined)
                .unref();
            },
          },
        });
      } catch (error) {
        if (!(error instanceof UnrevokedGrant)) throw error;
        await grants.save(error.grant);
        fail(`${error.message} Run \`parlor-host disconnect ${origin}\` to try again.`);
        return;
      }
      if (!outcome.paired) {
        const why = {
          declined_locally: "You did not confirm the connection here.",
          declined_in_app: "The connection was cancelled in the browser.",
          timeout: "The connection was not approved within 10 minutes.",
        }[outcome.reason];
        fail(`Not connected. ${why}`);
        return;
      }
      grant = outcome.grant;
      await grants.save(grant);
    }
    const client = await kit.ensureDaemon(paths);
    const reply = await client.send({ op: "connect", appOrigin: origin });
    client.close();
    if (!reply.ok) {
      fail(reply.error);
      return;
    }
    process.stdout.write(
      `Connected to ${printable(grant.appName)} as ${printable(grant.account.email ?? grant.account.name)}. Your agents are ready in its sidebar.\n`,
    );
  },
});

const disconnect = defineCommand({
  meta: { name: "disconnect", description: "Disconnect this computer from a Parlor app" },
  args: { url: { type: "positional", required: true, description: "The app's URL" } },
  async run({ args }) {
    const kit = await host();
    await kit
      .disconnectFrom(new URL(args.url).origin)
      .catch((error: unknown) => fail(errorText(error)));
  },
});

const status = defineCommand({
  meta: { name: "status", description: "Show the apps this computer serves" },
  args: { json: { type: "boolean", description: "Print one JSON line" } },
  async run({ args }) {
    const kit = await host();
    const client = await kit.connectControl(kit.hostPaths().control);
    const reply = client ? await client.send({ op: "status" }) : undefined;
    client?.close();
    const current = reply?.ok ? reply.status : ({ state: "stopped" } as const);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(current)}\n`);
    } else if (current.state === "stopped") {
      process.stdout.write("Parlor Host is not running.\n");
    } else {
      const apps = current.apps.map((app) => `  ${app}`).join("\n");
      process.stdout.write(
        `Parlor Host ${current.version} is serving:\n${apps || "  no app yet"}\n`,
      );
    }
  },
});

const daemon = defineCommand({
  meta: {
    name: "daemon",
    description: "Run the background host for every connected app",
  },
  async run() {
    const kit = await host();
    const paths = kit.hostPaths();
    const shutdown = shutdownSignal();
    const running = kit.daemonFor(paths, kit.fileGrantStore(paths.grants));
    await running.start();
    await untilAborted(shutdown);
    await running.stop();
    process.exit(0);
  },
});

const dev = defineCommand({
  meta: { name: "dev", description: "Serve a local `parlor dev` server" },
  args: {
    app: { type: "string", required: true, description: "http://localhost:<port>" },
  },
  async run({ args }) {
    const [kit, { NoDevAuth, requestDevHostToken }] = await Promise.all([
      host(),
      import("./dev-host.js"),
    ]);
    const origin = new URL(args.app).origin;
    const shutdown = shutdownSignal();
    const stopped = untilAborted(shutdown);
    let hostToken: string;
    try {
      hostToken = await requestDevHostToken(origin, shutdown);
    } catch (error) {
      if (shutdown.aborted) process.exit();
      if (!(error instanceof NoDevAuth)) throw error;
      process.stdout.write(
        "Parlor Host: this app signs people in itself; connect this computer from its sidebar.\n",
      );
      return;
    }
    const home = kit.hostPaths();
    const shared = await kit.connectControl(home.control);
    if (shared) {
      const reply = await shared.send({ op: "dev_attach", appOrigin: origin, hostToken });
      if (!reply.ok) fail(reply.error);
      await stopped;
      await shared.send({ op: "dev_detach", appOrigin: origin });
      shared.close();
      process.exit();
    }
    const root = await mkdtemp(join(tmpdir(), "parlor-host-dev-"));
    const paths = {
      ...kit.hostPaths(root),
      agents: home.agents,
      workspaces: home.workspaces,
    };
    const own = kit.daemonFor(paths, memoryGrants());
    await own.start();
    const client = await kit.connectControl(paths.control);
    const reply = await client!.send({ op: "dev_attach", appOrigin: origin, hostToken });
    client!.close();
    if (!reply.ok) fail(reply.error);
    await stopped;
    await own.stop();
    await rm(root, { recursive: true, force: true });
    process.exit();
  },
});

function memoryGrants(): GrantStore {
  const grants = new Map<string, AppGrant>();
  return {
    list: async () => [...grants.values()],
    get: async (appOrigin) => grants.get(appOrigin),
    save: async (grant) => void grants.set(grant.appOrigin, grant),
    remove: async (appOrigin) => void grants.delete(appOrigin),
  };
}

const mcpProxy = defineCommand({
  meta: { name: "mcp-proxy", description: "Internal: an agent's stdio MCP server" },
  async run() {
    const { runMcpProxyProcess } = await import("./mcp-proxy.js");
    await runMcpProxyProcess(process.env);
  },
});

await runMain(
  defineCommand({
    meta: {
      name: "parlor-host",
      description: "Run your own agents for your Parlor apps",
    },
    subCommands: { connect, disconnect, status, daemon, dev, "mcp-proxy": mcpProxy },
  }),
);
