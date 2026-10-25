import { execFile } from "node:child_process";

import type { AgentProfile } from "./agents.js";
import { logEvent } from "./log.js";
import { appServerOf } from "./naming.js";

/** What a grant hands the coding agents on this computer, outside the app's sidebar. */
export interface AgentTools {
  /** The MCP server name the agents know the app by, and the name the user asks them with. */
  readonly name: string;
  /** The agents it is registered with, by profile id. */
  readonly agents: readonly string[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The app's name, with its host and port when it is not a deployed site on the default
 * port: `coursekit`, or `coursekit-localhost-7001` beside it.
 */
export function agentToolsName(appName: string, appOrigin: string): string {
  const url = new URL(appOrigin);
  const base = appServerOf(appName);
  if (!LOCAL_HOSTS.has(url.hostname) && url.port === "") return base;
  const where = url.host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base}-${where}`;
}

/** How one coding agent's own CLI adds and removes a user-wide stdio MCP server. */
interface Registrar {
  add(name: string, command: readonly string[]): readonly string[];
  remove(name: string): readonly string[];
}

const REGISTRARS: Readonly<Record<string, Registrar>> = {
  claude: {
    add: (name, command) => ["mcp", "add", "--scope", "user", name, "--", ...command],
    remove: (name) => ["mcp", "remove", "--scope", "user", name],
  },
  codex: {
    add: (name, command) => ["mcp", "add", name, "--", ...command],
    remove: (name) => ["mcp", "remove", name],
  },
};

export interface AgentToolsDeps {
  /** The installed agents; only those with a known CLI are registered with. */
  readonly profiles: readonly AgentProfile[];
  /** The absolute path of `parlor-host`, which the agents launch as the MCP server. */
  readonly hostCommand: string;
  readonly env: () => Promise<Record<string, string>>;
}

function run(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, [...args], { env, timeout: 30_000 }, (error) => resolve(!error));
  });
}

/** Registers `appOrigin` with every installed agent that has a CLI for it; returns those that took it. */
export async function registerAgentTools(
  deps: AgentToolsDeps,
  app: { readonly appName: string; readonly appOrigin: string },
): Promise<AgentTools> {
  const name = agentToolsName(app.appName, app.appOrigin);
  const command = [deps.hostCommand, "mcp-proxy", "--app", app.appOrigin];
  const env = await deps.env();
  const agents: string[] = [];
  for (const profile of deps.profiles) {
    const registrar = REGISTRARS[profile.id];
    if (!registrar) continue;
    await run(profile.binary, registrar.remove(name), env);
    if (await run(profile.binary, registrar.add(name, command), env))
      agents.push(profile.id);
  }
  logEvent("agent_tools_registered", { appOrigin: app.appOrigin, name, agents });
  return { name, agents };
}

/** Removes the app from the agents it was registered with; an agent already rid of it is fine. */
export async function unregisterAgentTools(
  deps: AgentToolsDeps,
  tools: AgentTools,
): Promise<void> {
  const env = await deps.env();
  for (const id of tools.agents) {
    const registrar = REGISTRARS[id];
    const profile = deps.profiles.find((candidate) => candidate.id === id);
    if (!registrar || !profile) continue;
    await run(profile.binary, registrar.remove(tools.name), env);
  }
  logEvent("agent_tools_removed", { name: tools.name, agents: tools.agents });
}

/** The agents an `AgentTools` names, as people know them: "Claude Code and Codex". */
export function agentNames(profiles: readonly AgentProfile[], tools: AgentTools): string {
  const names = tools.agents.map(
    (id) => profiles.find((profile) => profile.id === id)?.name ?? id,
  );
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
