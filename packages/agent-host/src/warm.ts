import { mkdir } from "node:fs/promises";

import {
  type AgentConnection,
  type AgentLauncher,
  type OpenSessionInput,
  SessionRefused,
} from "./acp.js";
import type { AgentProfile } from "./agents.js";
import type { AppGrant } from "./grants.js";
import type { AppLink } from "./link.js";
import { logEvent } from "./log.js";
import type { McpProxy, ProxySession } from "./mcp-proxy.js";
import { appServerOf } from "./naming.js";
import type { RemotePolicy } from "./policy.js";
import type { SessionPool } from "./pool.js";
import { agentEnvironment } from "./shell-path.js";

export const WARM_IDLE_MS = 10 * 60_000;

/** The app's agent process: the running one, or one started in the grant's workspace. */
export function launchAgent(
  pool: SessionPool,
  launcher: AgentLauncher,
  profile: AgentProfile,
  grant: AppGrant,
): Promise<AgentConnection> {
  return pool.launch(grant.appOrigin, profile.id, async (signal) => {
    await mkdir(grant.workspace, { recursive: true, mode: 0o700 });
    return launcher.launch(profile, {
      cwd: grant.workspace,
      env: await agentEnvironment(),
      signal,
    });
  });
}

const askModes = (policy: RemotePolicy) => ({
  strictAsk: policy.answers !== "off",
  autoMode: policy.agentMode !== "ask",
});

export function sessionInput(
  grant: AppGrant,
  policy: RemotePolicy,
  proxy: ProxySession,
  resume: string | undefined,
): OpenSessionInput {
  return {
    cwd: grant.workspace,
    mcpServers: [proxy.server],
    resume,
    pinAskMode: true,
    ...askModes(policy),
  };
}

/** What a session is opened under; a warm one opened under another is never a turn's. */
export function sessionFit(grant: AppGrant, policy: RemotePolicy): string {
  const { strictAsk, autoMode } = askModes(policy);
  return JSON.stringify([grant.workspace, strictAsk, autoMode]);
}

export interface WarmDeps {
  readonly link: AppLink;
  readonly profiles: readonly AgentProfile[];
  readonly launcher: AgentLauncher;
  readonly pool: SessionPool;
  readonly proxy: McpProxy;
  readonly policy: RemotePolicy;
}

/**
 * `kept`: a warm session waited and waits on. `launched`: the agent runs, but no session
 * opens before the app first answered a turn's handshake, which a warm session replays.
 */
export type WarmOutcome = "kept" | "warmed" | "launched" | "unknown_agent" | "failed";

/** Starts the agent and opens a session for the app's next new thread, before its prompt. */
export async function warmAgent(agentId: string, deps: WarmDeps): Promise<WarmOutcome> {
  const grant = deps.link.grant;
  const profile = deps.profiles.find((candidate) => candidate.id === agentId);
  if (!profile) return "unknown_agent";
  const fit = sessionFit(grant, deps.policy);
  if (deps.pool.warm(grant, agentId, fit, WARM_IDLE_MS)) return "kept";
  let proxy: ProxySession | undefined;
  try {
    const connection = await launchAgent(deps.pool, deps.launcher, profile, grant);
    if (!deps.proxy.knowsHandshake(grant.appOrigin)) return "launched";
    proxy = deps.proxy.open(appServerOf(grant.appName), grant.appOrigin);
    const session = await connection.openSession(
      sessionInput(grant, deps.policy, proxy, undefined),
    );
    deps.pool.keepWarm(grant, agentId, { session, proxy }, fit, WARM_IDLE_MS);
    return "warmed";
  } catch (error) {
    proxy?.dispose();
    if (error instanceof SessionRefused && error.leftOpen) {
      await deps.pool.drop(grant.appOrigin, agentId);
    }
    logEvent("warm_failed", {
      appOrigin: grant.appOrigin,
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
