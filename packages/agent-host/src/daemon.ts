import { chmod, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, delimiter, join } from "node:path";
import { createInterface } from "node:readline";

import type { LocalHostStatus } from "@parlor/capabilities";
import {
  type AgentInfo,
  type ClaimedTurn,
  HOST_PROTOCOL,
  type HostWelcome,
} from "@parlor/chat";
import { ActionError, asId, DEV_USER_ID } from "@parlor/core";

import type { AgentLauncher } from "./acp.js";
import { type AgentProfile, detectAgents, loadProfiles } from "./agents.js";
import { connectControl, type ControlRequest } from "./control.js";
import { requestDevHostToken } from "./dev-host.js";
import { type AppGrant, devHostKeys, type GrantStore, type HostKeys } from "./grants.js";
import { type AppLink, createAppLink } from "./link.js";
import { logEvent, openHostLog } from "./log.js";
import type { McpProxy } from "./mcp-proxy.js";
import { computerName, platformName, workspaceOf } from "./naming.js";
import type { HostPaths } from "./paths.js";
import type { RemotePolicy } from "./policy.js";
import type { SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import type { HostRelease } from "./service.js";
import { runTurn } from "./turn.js";

export interface DaemonDeps {
  readonly release: HostRelease;
  readonly paths: HostPaths;
  readonly grants: GrantStore;
  readonly keys: HostKeys;
  readonly pool: SessionPool;
  readonly proxy: McpProxy;
  readonly launcher: AgentLauncher;
  readonly prompter: LocalPrompter;
  readonly policy: RemotePolicy;
}

/**
 * One per user per computer, for every app: an `AppLink` per grant, the session pool,
 * the proxy socket and the control socket. Started only through `ensureService`.
 */
export interface HostDaemon {
  start(): Promise<void>;
  connect(appOrigin: string): Promise<void>;
  disconnect(appOrigin: string): Promise<void>;
  stop(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;
const OFFLINE_REPORT_MS = 1_000;
function incompatibleMessage(
  grant: AppGrant,
  welcome: Extract<HostWelcome, { readonly accepted: false }>,
): string {
  return welcome.reason === "host_too_old"
    ? `Update Parlor Host to use ${grant.appName}: it speaks host protocol ${HOST_PROTOCOL}, and ${grant.appName} needs ${welcome.protocols.min}.`
    : `${grant.appName} is older than this Parlor Host: it speaks host protocol ${welcome.protocols.max}, and this computer needs ${HOST_PROTOCOL}.`;
}

/**
 * Agents reach their MCP server as `parlor-host`: a link to this CLI that the daemon puts
 * first on their PATH, so it resolves whether or not the host is installed globally.
 */
async function exposeHostCommand(root: string): Promise<void> {
  const entry = process.argv[1];
  if (!entry || !basename(entry).startsWith("parlor-host")) return;
  const bin = join(root, "bin");
  const link = join(bin, "parlor-host");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const target = await realpath(entry);
  if ((await readlink(link).catch(() => undefined)) !== target) {
    await rm(link, { force: true });
    await symlink(target, link);
  }
  const path = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== bin);
  process.env.PATH = [bin, ...path].join(delimiter);
}

interface LinkState {
  readonly link: AppLink;
  readonly keys: HostKeys;
  claiming: boolean;
  again: boolean;
  incompatible: string | undefined;
}

export function createHostDaemon(deps: DaemonDeps): HostDaemon {
  const { paths } = deps;
  const links = new Map<string, LinkState>();
  const devTokens = new Map<string, string>();
  const name = computerName();
  const platform = platformName();
  let profiles: readonly AgentProfile[] = [];
  let agents: AgentInfo[] = [];
  let control: Server | undefined;
  const clients = new Set<Socket>();

  const claim = async (link: AppLink): Promise<ClaimedTurn | undefined> => {
    try {
      return await link.api.calls.call("hostClaim", {});
    } catch (error) {
      if (!(error instanceof ActionError && error.code === "not_found")) {
        logEvent("claim_failed", {
          appOrigin: link.grant.appOrigin,
          error: String(error),
        });
      }
      return undefined;
    }
  };

  const run = (link: AppLink, claimed: ClaimedTurn) => {
    logEvent("turn_claimed", { appOrigin: link.grant.appOrigin, turnId: claimed.turnId });
    runTurn(claimed, {
      link,
      profiles,
      launcher: deps.launcher,
      pool: deps.pool,
      proxy: deps.proxy,
      policy: deps.policy,
      prompter: deps.prompter,
      now: Date.now,
    }).then(
      (outcome) => logEvent("turn_finished", { turnId: claimed.turnId, outcome }),
      (error: unknown) =>
        logEvent("turn_finished", { turnId: claimed.turnId, error: String(error) }),
    );
  };

  const wake = async (state: LinkState) => {
    if (state.claiming) {
      state.again = true;
      return;
    }
    state.claiming = true;
    try {
      do {
        state.again = false;
        for (
          let claimed = await claim(state.link);
          claimed;
          claimed = await claim(state.link)
        ) {
          run(state.link, claimed);
        }
      } while (state.again);
    } finally {
      state.claiming = false;
    }
  };

  const closeLink = async (
    origin: string,
    reason: string,
    options: { readonly revoke?: boolean } = {},
  ) => {
    const state = links.get(origin);
    links.delete(origin);
    await state?.link.stop(options);
    await deps.pool.drop(origin);
    if (state) logEvent("link_closed", { appOrigin: origin, reason });
  };

  const forget = async (origin: string) => {
    devTokens.delete(origin);
    await deps.grants.remove(origin);
    await deps.keys.remove(origin);
  };

  const open = (grant: AppGrant, keys: HostKeys): LinkState => {
    const origin = grant.appOrigin;
    let state: LinkState;
    const link = createAppLink(grant, {
      keys,
      hostVersion: deps.release.version,
      hostName: name,
      platform,
      fetch: (input, init) => fetch(input, init),
      onWake: () => void wake(state),
      onRevoked: () => {
        if (links.get(origin) !== state) return;
        if (grant.dev) void reattach(grant);
        else void closeLink(origin, "revoked").then(() => forget(origin));
      },
      onIncompatible: (refused, welcome) => {
        state.incompatible = incompatibleMessage(refused, welcome);
        process.stderr.write(`${state.incompatible}\n`);
      },
    });
    state = { link, keys, claiming: false, again: false, incompatible: undefined };
    links.set(origin, state);
    link.start();
    return state;
  };

  const report = async (state: LinkState) => {
    const reported = state.link.api.calls.call("hostReport", { online: true, agents });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("The app did not answer in time.")),
        CONNECT_TIMEOUT_MS,
      ),
    );
    try {
      await Promise.race([reported, timeout]);
    } catch (error) {
      throw new Error(
        state.incompatible ?? (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  };

  const devGrant = async (origin: string): Promise<AppGrant> => {
    const manifest = await fetch(`${origin}/_parlor/manifest`)
      .then((response) => response.json() as Promise<{ app?: { name?: string } }>)
      .catch(() => undefined);
    return {
      appOrigin: origin,
      appName: manifest?.app?.name ?? new URL(origin).host,
      grantId: asId("grant", "dev"),
      hostId: asId("host", "dev"),
      account: { userId: DEV_USER_ID, name: "Developer" },
      workspace: workspaceOf(paths.workspaces, origin),
      createdAt: Date.now(),
      dev: true,
    };
  };

  const attach = async (origin: string, hostToken: string) => {
    await closeLink(origin, "replaced");
    devTokens.set(origin, hostToken);
    await report(open(await devGrant(origin), devHostKeys(hostToken)));
  };

  const reattach = async (grant: AppGrant) => {
    await closeLink(grant.appOrigin, "dev_server_restarted");
    if (!devTokens.has(grant.appOrigin)) return;
    try {
      const token = await requestDevHostToken(grant.appOrigin);
      if (devTokens.has(grant.appOrigin)) await attach(grant.appOrigin, token);
    } catch (error) {
      logEvent("dev_attach_failed", { appOrigin: grant.appOrigin, error: String(error) });
    }
  };

  const status = (): LocalHostStatus => ({
    state: "running",
    version: deps.release.version,
    apps: [...links.keys()],
  });

  const daemon: HostDaemon = {
    async start() {
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      const running = await connectControl(paths.control);
      if (running) {
        running.close();
        throw new Error("Parlor Host is already running on this computer.");
      }
      openHostLog(join(paths.root, "logs", "daemon.log"));
      await exposeHostCommand(paths.root);
      await deps.proxy.listen(paths.proxy);
      profiles = await loadProfiles(paths.agents);
      agents = await detectAgents(profiles);
      control = createServer(serve);
      await rm(paths.control, { force: true });
      await new Promise<void>((resolve, reject) => {
        control!.once("error", reject);
        control!.listen(paths.control, () => resolve());
      });
      await chmod(paths.control, 0o600);
      logEvent("daemon_started", {
        version: deps.release.version,
        agents: agents.map((a) => a.id),
      });
      for (const grant of await deps.grants.list()) {
        void report(open(grant, deps.keys)).catch((error: unknown) =>
          logEvent("link_failed", { appOrigin: grant.appOrigin, error: String(error) }),
        );
      }
    },
    async connect(appOrigin) {
      const grant = await deps.grants.get(appOrigin);
      if (!grant) throw new Error(`This computer is not connected to ${appOrigin}.`);
      await closeLink(appOrigin, "replaced");
      await report(open(grant, deps.keys));
    },
    async disconnect(appOrigin) {
      await closeLink(appOrigin, "disconnected", { revoke: true });
      await forget(appOrigin);
    },
    async stop() {
      await Promise.all(
        [...links.values()].map((state) =>
          Promise.race([
            state.link.api.calls.call("hostReport", { online: false, agents }),
            new Promise((resolve) => setTimeout(resolve, OFFLINE_REPORT_MS)),
          ]).catch(() => undefined),
        ),
      );
      for (const origin of [...links.keys()]) await closeLink(origin, "stopped");
      for (const socket of clients) socket.destroy();
      const closing = control;
      control = undefined;
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
      await rm(paths.control, { force: true });
      await deps.proxy.close();
    },
  };

  const handle = async (request: ControlRequest): Promise<unknown> => {
    switch (request.op) {
      case "status":
        return { ok: true, status: status() };
      case "connect":
        await daemon.connect(request.appOrigin);
        return { ok: true };
      case "disconnect":
        await daemon.disconnect(request.appOrigin);
        return { ok: true };
      case "dev_attach":
        await attach(request.appOrigin, request.hostToken);
        return { ok: true };
      case "dev_detach":
        devTokens.delete(request.appOrigin);
        await closeLink(request.appOrigin, "detached");
        return { ok: true };
    }
  };

  function serve(socket: Socket) {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      let request: ControlRequest;
      try {
        request = JSON.parse(line) as ControlRequest;
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: "Not JSON." })}\n`);
        return;
      }
      void handle(request)
        .catch((error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((reply) => {
          if (!socket.destroyed)
            socket.write(
              `${JSON.stringify(reply ?? { ok: false, error: "Unknown op." })}\n`,
            );
        });
    });
  }

  return daemon;
}
