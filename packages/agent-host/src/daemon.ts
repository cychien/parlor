import {
  chmod,
  mkdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import {
  agentNames,
  type AgentToolsDeps,
  registerAgentTools,
  unregisterAgentTools,
} from "./agent-tools.js";
import { type AgentProfile, detectAgents, loadProfiles } from "./agents.js";
import { connectControl, type ControlRequest } from "./control.js";
import { requestDevHostToken } from "./dev-host.js";
import { type AppGrant, devHostKeys, type GrantStore, type HostKeys } from "./grants.js";
import { learnedStore } from "./learned.js";
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
import { DEV_POLICY, loadPolicy, presenceDueAt, type RemotePolicy } from "./policy.js";
import type { SessionPool } from "./pool.js";
import { type LocalPrompter, printable } from "./prompter.js";
import { compareVersions, RELEASE_KEY, signedRelease } from "./release.js";
import { revokeGrant } from "./revoke.js";
import { selfEntry } from "./self.js";
import { type HostRelease, installLoginItem, installRelease } from "./service.js";
import { agentEnvironment } from "./shell-path.js";
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
  /** What the coding agents here know the app by, when the user let them use it. */
  connect(appOrigin: string): Promise<ConnectedTools | undefined>;
  disconnect(appOrigin: string): Promise<ConnectedTools | undefined>;
  /** Lets the coding agents here use the app outside its sidebar, or stops them. */
  agentTools(appOrigin: string, on: boolean): Promise<ConnectedTools | undefined>;
  /** Hands links over to a newer release; running turns finish here first. */
  handover(): Promise<void>;
  stop(): Promise<void>;
}

/** The app's MCP server name in the coding agents here, and which of them have it. */
export interface ConnectedTools {
  readonly name: string;
  readonly agents: string;
}

const CONNECT_TIMEOUT_MS = 15_000;
/** An agent token is asked for again this long before it runs out. */
const AGENT_TOKEN_MARGIN_MS = 60_000;
const OFFLINE_REPORT_MS = 1_000;
function incompatibleMessage(
  grant: AppGrant,
  welcome: Extract<HostWelcome, { readonly accepted: false }>,
): string {
  return welcome.reason === "host_too_old"
    ? `Update Parlor Host to use ${grant.appName}: it speaks host protocol ${HOST_PROTOCOL}, and ${grant.appName} needs ${welcome.protocols.min}.`
    : `${grant.appName} is older than this Parlor Host: it speaks host protocol ${welcome.protocols.max}, and this computer needs ${HOST_PROTOCOL}.`;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Agents start `parlor-host mcp-proxy` by name. An entry named otherwise, such as the
 * published `dist/main.js` that `parlor dev` runs with node, gets a shim instead of a link.
 */
export async function putHostCommandFirstOnPath(
  root: string,
  entry: string | undefined = selfEntry(),
): Promise<void> {
  if (!entry) return;
  const bin = join(root, "bin");
  const link = join(bin, "parlor-host");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const target = await realpath(entry);
  if (basename(entry).startsWith("parlor-host")) {
    if ((await readlink(link).catch(() => undefined)) !== target) {
      await rm(link, { force: true });
      await symlink(target, link);
    }
  } else {
    await rm(link, { force: true });
    await writeFile(
      link,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(target)} "$@"\n`,
      { mode: 0o700 },
    );
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
  turns: number;
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
  const learned = learnedStore(paths.learned);
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

  const run = (state: LinkState, claimed: ClaimedTurn) => {
    const { link } = state;
    logEvent("turn_claimed", { appOrigin: link.grant.appOrigin, turnId: claimed.turnId });
    state.turns += 1;
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
          trust: {
            ...deps.trust,
            pin: async (appOrigin, device) => {
              await deps.trust.pin(appOrigin, device);
              void report(state).catch(() => undefined);
            },
            forget: async (appOrigin, deviceId) => {
              await deps.trust.forget(appOrigin, deviceId);
              void report(state).catch(() => undefined);
            },
          },
          policy,
          prompter: deps.prompter,
          now: Date.now,
          learned: (agentId, news) => {
            void learned
              .learn(agentId, news)
              .then((changed) => {
                if (!changed) return;
                for (const linked of links.values())
                  void report(linked).catch(() => undefined);
              })
              .catch(() => undefined);
          },
          pairing: {
            secret: async () =>
              (await deps.grants.get(link.grant.appOrigin))?.pairingSecret,
            forget: async () => {
              const saved = await deps.grants.get(link.grant.appOrigin);
              if (!saved?.pairingSecret) return;
              const { pairingSecret: _used, ...rest } = saved;
              await deps.grants.save(rest);
            },
          },
        }),
      )
      .then(
        (outcome) => logEvent("turn_finished", { turnId: claimed.turnId, outcome }),
        (error: unknown) =>
          logEvent("turn_finished", { turnId: claimed.turnId, error: String(error) }),
      )
      .finally(() => {
        state.turns -= 1;
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
        run(state, claimed);
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

  const toolsDeps = (): AgentToolsDeps => ({
    profiles: profiles.filter((profile) =>
      agents.some((agent) => agent.id === profile.id),
    ),
    hostCommand: join(paths.root, "bin", "parlor-host"),
    env: agentEnvironment,
  });

  const toolsOf = (grant: AppGrant | undefined): ConnectedTools | undefined => {
    const tools = grant?.agentTools;
    if (!tools?.on || !tools.name || !tools.agents?.length) return undefined;
    return {
      name: tools.name,
      agents: agentNames(profiles, { name: tools.name, agents: tools.agents }),
    };
  };

  /** Registers the app with the agents here once the user chose it and it is not yet. */
  const ensureAgentTools = async (grant: AppGrant): Promise<AppGrant> => {
    if (!grant.agentTools?.on || grant.dev || grant.agentTools.agents) return grant;
    const registered = await registerAgentTools(toolsDeps(), grant);
    const next: AppGrant = { ...grant, agentTools: { on: true, ...registered } };
    await deps.grants.save(next);
    return next;
  };

  const removeAgentTools = async (grant: AppGrant | undefined) => {
    const tools = grant?.agentTools;
    if (!tools?.name || !tools.agents?.length) return;
    await unregisterAgentTools(toolsDeps(), { name: tools.name, agents: tools.agents });
  };

  const agentTokens = new Map<
    string,
    { readonly token: string; readonly expiresAt: number }
  >();
  /** The grant as last saved, which a link opened before a change still holds the old copy of. */
  const latest = new Map<string, AppGrant>();

  deps.proxy.serveOutside((appOrigin) => {
    const state = links.get(appOrigin);
    if (!state || state.link.grant.dev) return undefined;
    const grant = latest.get(appOrigin) ?? state.link.grant;
    if (!grant.agentTools?.on || !grant.agentTools.name) return undefined;
    return {
      appOrigin,
      appName: grant.appName,
      name: grant.agentTools.name,
      account: grant.account.email ?? grant.account.name,
      token: async (agent) => {
        const key = `${grant.grantId}\n${agent}`;
        const held = agentTokens.get(key);
        if (held && held.expiresAt - AGENT_TOKEN_MARGIN_MS > Date.now())
          return held.token;
        const fresh = await state.link.api.calls.call("hostAgentToken", {
          agent: `${agent} on ${name}`.slice(0, 120),
        });
        agentTokens.set(key, fresh);
        return fresh.token;
      },
      askHere: async (question) =>
        (await deps.prompter.answerHere({
          appName: grant.appName,
          agent: "Parlor Host",
          question,
          choices: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Don't allow" },
          ],
        })) === "allow",
    };
  });

  const forget = async (grant: AppGrant) => {
    await removeAgentTools((await deps.grants.get(grant.appOrigin)) ?? grant);
    latest.delete(grant.appOrigin);
    for (const key of agentTokens.keys()) {
      if (key.startsWith(`${grant.grantId}\n`)) agentTokens.delete(key);
    }
    devTokens.delete(grant.appOrigin);
    await deps.grants.remove(grant.appOrigin);
    await deps.keys.remove(grant.appOrigin);
    await deps.trust.forget(grant.appOrigin);
    await deps.pool.forget(grant);
  };

  const open = (grant: AppGrant, keys: HostKeys): LinkState => {
    const origin = grant.appOrigin;
    latest.set(origin, grant);
    let state: LinkState;
    const link = createAppLink(grant, {
      keys,
      hostVersion: deps.release.version,
      hostName: name,
      platform,
      fetch: (input, init) => fetch(input, init),
      onWake: () => wake(state),
      busy: () => state.turns > 0,
      onRevoked: () => {
        if (links.get(origin) !== state) return;
        if (grant.dev) void reattach(grant);
        else {
          const removedFrom = toolsOf(latest.get(origin) ?? grant)?.agents;
          void closeLink(origin, "revoked")
            .then(() => forget(grant))
            .then(() =>
              deps.prompter.disconnected?.({ appName: grant.appName, removedFrom }),
            );
        }
      },
      onIncompatible: (refused, welcome) => {
        state.incompatible = incompatibleMessage(refused, welcome);
        process.stderr.write(`${printable(state.incompatible)}\n`);
      },
    });
    state = {
      link,
      keys,
      claiming: undefined,
      again: false,
      incompatible: undefined,
      turns: 0,
    };
    links.set(origin, state);
    link.start();
    return state;
  };

  const pinnedDevices = async (state: LinkState) => {
    if (state.link.grant.dev) return {};
    const [pinned, policy] = await Promise.all([
      deps.trust.list(state.link.grant.appOrigin),
      loadPolicy(paths.policy, deps.policy),
    ]);
    const presenceDue: Record<string, number> = {};
    for (const device of pinned) {
      const due = presenceDueAt(policy, device);
      if (due !== undefined) presenceDue[device.deviceId] = due;
    }
    return { devices: pinned.map((device) => device.deviceId), presenceDue };
  };

  /** The agents with what they said about themselves, and the name they use the app by outside. */
  const describeFor = (origin: string) => {
    const tools = latest.get(origin)?.agentTools;
    return learned
      .describe(agents, Date.now())
      .map((agent) =>
        tools?.on && tools.name && tools.agents?.includes(agent.id)
          ? { ...agent, outsideName: tools.name }
          : agent,
      );
  };

  const report = async (state: LinkState) => {
    const reported = state.link.api.calls.call("hostReport", {
      online: true,
      agents: describeFor(state.link.grant.appOrigin),
      ...(await pinnedDevices(state)),
    });
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
        await learned.load();
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
      const saved = await deps.grants.get(appOrigin);
      if (!saved || saved.declined) {
        throw new Error(`This computer is not connected to ${appOrigin}.`);
      }
      const grant = await ensureAgentTools(saved);
      const current = links.get(appOrigin);
      if (current?.link.grant.grantId === grant.grantId) {
        latest.set(appOrigin, grant);
        await report(current);
        return toolsOf(grant);
      }
      await closeLink(appOrigin, "replaced");
      if (current) await deps.pool.forget(current.link.grant);
      latest.set(appOrigin, grant);
      await report(open(grant, deps.keys));
      return toolsOf(grant);
    },
    async agentTools(appOrigin, on) {
      const saved = await deps.grants.get(appOrigin);
      if (!saved || saved.declined || saved.dev) {
        throw new Error(`This computer is not connected to ${appOrigin}.`);
      }
      if (!on) await removeAgentTools(saved);
      const grant = await ensureAgentTools({ ...saved, agentTools: { on } });
      if (!on) await deps.grants.save(grant);
      latest.set(appOrigin, grant);
      const state = links.get(appOrigin);
      if (state) await report(state).catch(() => undefined);
      return toolsOf(grant);
    },
    async disconnect(appOrigin) {
      const state = links.get(appOrigin);
      const grant = (await deps.grants.get(appOrigin)) ?? state?.link.grant;
      if (!grant) throw new Error(`This computer is not connected to ${appOrigin}.`);
      const removed = toolsOf(grant);
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
      return removed;
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
              state.link.api.calls.call("hostReport", {
                online: false,
                agents: describeFor(state.link.grant.appOrigin),
              }),
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
        const begun = await pairing.pairing;
        logEvent("local_pairing_begun", {
          appOrigin: origin,
          matchingCode: begun.matchingCode,
        });
        return { ok: true, pairing: begun };
      }
      case "finish_local_pairing": {
        const { pairing } = pendingPairing(request.appOrigin);
        if (!pairing) return { ok: false, error: "No pairing was started for this app." };
        return { ok: true, ...(await pairing.finish(request.code)) };
      }
      case "confirm_local_pairing":
        return confirmPairing(request);
      case "connect": {
        const agentTools = await daemon.connect(request.appOrigin);
        return { ok: true, ...(agentTools ? { agentTools } : {}) };
      }
      case "disconnect": {
        const agentTools = await daemon.disconnect(request.appOrigin);
        return { ok: true, ...(agentTools ? { agentTools } : {}) };
      }
      case "agent_tools": {
        const agentTools = await daemon.agentTools(request.appOrigin, request.on);
        return { ok: true, ...(agentTools ? { agentTools } : {}) };
      }
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
