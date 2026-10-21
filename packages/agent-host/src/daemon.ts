import { chmod, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, delimiter, dirname, join } from "node:path";

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
import { onLines } from "./lines.js";
import { type AppLink, createAppLink } from "./link.js";
import { withInheritedLock } from "./lock.js";
import { logEvent, openHostLog } from "./log.js";
import type { McpProxy } from "./mcp-proxy.js";
import { computerName, platformName, workspaceOf } from "./naming.js";
import {
  type LocalPairing,
  pairingDeviceOf,
  startLocalPairing,
  UnrevokedGrant,
} from "./pairing.js";
import type { HostPaths } from "./paths.js";
import { DEV_POLICY, loadPolicy, type RemotePolicy } from "./policy.js";
import type { SessionPool } from "./pool.js";
import { type LocalPrompter, printable } from "./prompter.js";
import { compareVersions, RELEASE_KEY, signedRelease } from "./release.js";
import { revokeGrant } from "./revoke.js";
import { selfEntry } from "./self.js";
import { type HostRelease, installLoginItem, installRelease } from "./service.js";
import type { TrustStore } from "./trust.js";
import { runTurn } from "./turn.js";

export interface DaemonDeps {
  readonly release: HostRelease;
  readonly paths: HostPaths;
  readonly grants: GrantStore;
  readonly keys: HostKeys;
  readonly trust: TrustStore;
  readonly pool: SessionPool;
  readonly proxy: McpProxy;
  readonly launcher: AgentLauncher;
  readonly prompter: LocalPrompter;
  readonly policy: RemotePolicy;
  /** The `service.lock` token of the `ensureService` that spawned this daemon, which holds the lock for it. */
  readonly lockToken?: string | undefined;
}

/**
 * One per user per computer, for every app: an `AppLink` per grant, the session pool,
 * the proxy socket and the control socket. Started only through `ensureService`.
 */
export interface HostDaemon {
  start(): Promise<void>;
  connect(appOrigin: string): Promise<void>;
  disconnect(appOrigin: string): Promise<void>;
  /** Hands links over to a newer release; running turns finish here first. */
  handover(): Promise<void>;
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

async function putHostCommandFirstOnPath(root: string): Promise<void> {
  const entry = selfEntry();
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
  claiming: Promise<void> | undefined;
  again: boolean;
  incompatible: string | undefined;
}

/** The daemon a service runs: once it handed over, `drained` settles after its last turn. */
export interface ServiceDaemon extends HostDaemon {
  readonly drained: Promise<void>;
}

export class HostAlreadyRunning extends Error {
  override readonly name = "HostAlreadyRunning";
  constructor() {
    super("Parlor Host is already running on this computer.");
  }
}

export function createHostDaemon(deps: DaemonDeps): ServiceDaemon {
  const { paths } = deps;
  const links = new Map<string, LinkState>();
  const devTokens = new Map<string, string>();
  const name = computerName();
  const platform = platformName();
  let profiles: readonly AgentProfile[] = [];
  let agents: AgentInfo[] = [];
  let control: Server | undefined;
  let startup: Promise<void> = Promise.resolve();
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

  const running = new Set<Promise<void>>();
  let handedOver = false;
  let finishing = false;
  let finishHandover: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => (finishHandover = resolve));

  const run = (link: AppLink, claimed: ClaimedTurn) => {
    logEvent("turn_claimed", { appOrigin: link.grant.appOrigin, turnId: claimed.turnId });
    const turn = (
      link.grant.dev ? Promise.resolve(DEV_POLICY) : loadPolicy(paths.policy, deps.policy)
    )
      .then((policy) =>
        runTurn(claimed, {
          link,
          profiles,
          launcher: deps.launcher,
          pool: deps.pool,
          proxy: deps.proxy,
          trust: deps.trust,
          policy,
          prompter: deps.prompter,
          now: Date.now,
        }),
      )
      .then(
        (outcome) => logEvent("turn_finished", { turnId: claimed.turnId, outcome }),
        (error: unknown) =>
          logEvent("turn_finished", { turnId: claimed.turnId, error: String(error) }),
      )
      .finally(() => {
        running.delete(turn);
        settleHandover();
      });
    running.add(turn);
  };

  const claimLoop = async (state: LinkState) => {
    do {
      state.again = false;
      for (
        let claimed = await claim(state.link);
        claimed;
        claimed = state.link.mode === "serving" ? await claim(state.link) : undefined
      ) {
        run(state.link, claimed);
      }
    } while (state.again && state.link.mode === "serving");
  };

  const wake = (state: LinkState) => {
    if (state.link.mode !== "serving") return;
    if (state.claiming) {
      state.again = true;
      return;
    }
    state.claiming = claimLoop(state).finally(() => {
      state.claiming = undefined;
    });
  };

  const closeLink = async (origin: string, reason: string) => {
    const state = links.get(origin);
    links.delete(origin);
    await state?.link.stop();
    await deps.pool.drop(origin);
    if (state) logEvent("link_closed", { appOrigin: origin, reason });
  };

  const forget = async (grant: AppGrant) => {
    devTokens.delete(grant.appOrigin);
    await deps.grants.remove(grant.appOrigin);
    await deps.keys.remove(grant.appOrigin);
    await deps.trust.forget(grant.appOrigin);
    await deps.pool.forget(grant);
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
      onWake: () => wake(state),
      onRevoked: () => {
        if (links.get(origin) !== state) return;
        if (grant.dev) void reattach(grant);
        else void closeLink(origin, "revoked").then(() => forget(grant));
      },
      onIncompatible: (refused, welcome) => {
        state.incompatible = incompatibleMessage(refused, welcome);
        process.stderr.write(`${printable(state.incompatible)}\n`);
      },
    });
    state = { link, keys, claiming: undefined, again: false, incompatible: undefined };
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

  const grantsOf = () =>
    [...links.values()].map(({ link: { grant } }) => ({
      appOrigin: grant.appOrigin,
      appName: grant.appName,
      grantId: grant.grantId,
    }));

  const daemon: ServiceDaemon = {
    drained,
    async start() {
      let finishStartup!: () => void;
      let failStartup!: (error: unknown) => void;
      startup = new Promise<void>((resolve, reject) => {
        finishStartup = resolve;
        failStartup = reject;
      });
      startup.catch(() => undefined);
      try {
        await mkdir(paths.root, { recursive: true, mode: 0o700 });
        await withInheritedLock(paths.lock, deps.lockToken, async () => {
          const answering = await connectControl(paths.control);
          if (answering) {
            answering.close();
            throw new HostAlreadyRunning();
          }
          await mkdir(dirname(paths.control), { recursive: true, mode: 0o700 });
          control = createServer(serve);
          await rm(paths.control, { force: true });
          await new Promise<void>((resolve, reject) => {
            control!.once("error", reject);
            control!.listen(paths.control, () => resolve());
          });
          await chmod(paths.control, 0o600);
        });
        openHostLog(join(paths.root, "logs", "daemon.log"));
        await putHostCommandFirstOnPath(paths.root);
        await deps.proxy.listen(paths.proxy);
        profiles = await loadProfiles(paths.agents);
        agents = await detectAgents(profiles);
        finishStartup();
      } catch (error) {
        failStartup(error);
        throw error;
      }
      logEvent("daemon_started", {
        version: deps.release.version,
        agents: agents.map((a) => a.id),
      });
      for (const grant of await deps.grants.list()) {
        if (grant.declined) continue;
        void report(open(grant, deps.keys)).catch((error: unknown) =>
          logEvent("link_failed", { appOrigin: grant.appOrigin, error: String(error) }),
        );
      }
    },
    async connect(appOrigin) {
      const grant = await deps.grants.get(appOrigin);
      if (!grant || grant.declined) {
        throw new Error(`This computer is not connected to ${appOrigin}.`);
      }
      const current = links.get(appOrigin);
      if (current?.link.grant.grantId === grant.grantId) {
        await report(current);
        return;
      }
      await closeLink(appOrigin, "replaced");
      if (current) await deps.pool.forget(current.link.grant);
      await report(open(grant, deps.keys));
    },
    async disconnect(appOrigin) {
      const state = links.get(appOrigin);
      const grant = state?.link.grant ?? (await deps.grants.get(appOrigin));
      if (!grant) throw new Error(`This computer is not connected to ${appOrigin}.`);
      if (state) {
        await state.link.stop({ revoke: true });
      } else {
        await revokeGrant({
          appOrigin,
          appName: grant.appName,
          assert: (request) => deps.keys.assert(appOrigin, request),
        });
      }
      await closeLink(appOrigin, "disconnected");
      await forget(grant);
    },
    async handover() {
      if (handedOver) return;
      handedOver = true;
      for (const state of links.values()) state.link.drain();
      await Promise.all([...links.values()].map((state) => state.claiming));
      const closing = control;
      control = undefined;
      closing?.close();
      await Promise.all([rm(paths.control, { force: true }), deps.proxy.stopListening()]);
      logEvent("handover_started", { version: deps.release.version });
    },
    async stop() {
      if (!handedOver) {
        await Promise.all(
          [...links.values()].map((state) =>
            Promise.race([
              state.link.api.calls.call("hostReport", { online: false, agents }),
              new Promise((resolve) => setTimeout(resolve, OFFLINE_REPORT_MS)),
            ]).catch(() => undefined),
          ),
        );
      }
      for (const origin of [...links.keys()]) await closeLink(origin, "stopped");
      for (const socket of clients) socket.destroy();
      const closing = control;
      control = undefined;
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
      if (!handedOver) await rm(paths.control, { force: true });
      await deps.proxy.close();
    },
  };

  const settleHandover = () => {
    if (!handedOver || running.size > 0 || finishing) return;
    finishing = true;
    void (async () => {
      for (const origin of [...links.keys()]) await closeLink(origin, "handed_over");
      await Promise.all(
        [...clients].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.end(() => resolve());
              setTimeout(resolve, OFFLINE_REPORT_MS).unref();
            }),
        ),
      );
      logEvent("handover_finished", { version: deps.release.version });
      finishHandover();
    })();
  };

  const handOverTo = async (binary: string, signature: string): Promise<unknown> => {
    const release = await signedRelease(binary, signature, RELEASE_KEY);
    if (!release) return { ok: false, error: "unsigned" };
    if (compareVersions(release.version, deps.release.version) <= 0) {
      return { ok: false, error: "downgrade" };
    }
    if (!(await installRelease(paths, { binary, signature }, release))) {
      return { ok: false, error: "unsigned" };
    }
    await installLoginItem(paths);
    await daemon.handover();
    setImmediate(settleHandover);
    return { ok: true };
  };

  const pairings = new Map<string, LocalPairing>();

  const pendingPairing = (appOrigin: string) => {
    const origin = new URL(appOrigin).origin;
    return { origin, pairing: pairings.get(origin) };
  };

  const confirmPairing = async (
    request: Extract<ControlRequest, { readonly op: "confirm_local_pairing" }>,
  ): Promise<unknown> => {
    const { origin, pairing } = pendingPairing(request.appOrigin);
    if (!pairing) return { ok: false, error: "No pairing was started for this app." };
    pairings.delete(origin);
    let outcome: Awaited<ReturnType<LocalPairing["confirm"]>>;
    try {
      outcome = await pairing.confirm(request.connect);
    } catch (error) {
      if (!(error instanceof UnrevokedGrant)) throw error;
      await deps.grants.save(error.grant);
      return { ok: false, error: "declined_locally" };
    }
    if (!outcome.paired) return { ok: false, error: outcome.reason };
    const { grant } = outcome;
    await deps.grants.save(grant);
    const device = pairingDeviceOf(request.device);
    if (device) {
      await deps.trust.pin(grant.appOrigin, {
        deviceId: asId("device", device.deviceId),
        signingKey: device.signingKey,
        presenceKey: device.presenceKey,
        name: device.name,
        platform: device.platform,
        approvedAt: Date.now(),
        via: "pairing",
      });
    }
    await daemon.connect(grant.appOrigin);
    return { ok: true };
  };

  const handle = async (request: ControlRequest): Promise<unknown> => {
    if (request.op !== "hello") await startup;
    switch (request.op) {
      case "hello":
        return { ok: true, release: deps.release };
      case "handover":
        return handOverTo(request.binary, request.signature);
      case "status":
        return { ok: true, status: status(), grants: grantsOf() };
      case "begin_local_pairing": {
        const { origin } = pendingPairing(request.appOrigin);
        const existing = await deps.grants.get(origin);
        if (existing && !existing.declined) {
          return {
            ok: false,
            error: `This computer is already connected to ${existing.appName}.`,
          };
        }
        const pairing = startLocalPairing({
          appOrigin: origin,
          hostName: name,
          platform,
          keys: deps.keys,
          workspaceRoot: paths.workspaces,
        });
        pairings.set(origin, pairing);
        return { ok: true, pairing: await pairing.pairing };
      }
      case "finish_local_pairing": {
        const { pairing } = pendingPairing(request.appOrigin);
        if (!pairing) return { ok: false, error: "No pairing was started for this app." };
        return { ok: true, ...(await pairing.finish(request.code)) };
      }
      case "confirm_local_pairing":
        return confirmPairing(request);
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
    onLines(socket, (line) => {
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
