import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { AgentInfo } from "@parlor/chat";

import { agentPath } from "./shell-path.js";

/** The app picks an agent by `id` only, never by command, so no remote party chooses what runs. */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly launch: AgentLaunch;
  /** The CLI behind it, for the installed-and-logged-in check. */
  readonly binary: string;
}

/**
 * `adapter`: an npm ACP adapter at an exact version, run from the copy this build embeds
 * and else through `npx`. `native`: an agent CLI that speaks ACP itself, found on the login-shell PATH.
 */
export type AgentLaunch =
  | {
      readonly kind: "adapter";
      readonly package: string;
      readonly version: string;
      readonly args?: readonly string[] | undefined;
    }
  | {
      readonly kind: "native";
      readonly command: string;
      readonly args: readonly string[];
    };

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: "claude",
    name: "Claude Code",
    launch: {
      kind: "adapter",
      package: "@agentclientprotocol/claude-agent-acp",
      version: "0.93.0",
    },
    binary: "claude",
  },
  {
    id: "codex",
    name: "Codex",
    launch: {
      kind: "adapter",
      package: "@agentclientprotocol/codex-acp",
      version: "2.2.2",
    },
    binary: "codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    launch: { kind: "native", command: "gemini", args: ["--acp"] },
    binary: "gemini",
  },
];

/** Where each adapter looks for the agent CLI it drives; its own search does not survive a single executable. */
export const ADAPTER_BINARY_ENV: Readonly<Record<string, string>> = {
  "@agentclientprotocol/claude-agent-acp": "CLAUDE_CODE_EXECUTABLE",
  "@agentclientprotocol/codex-acp": "CODEX_PATH",
};

export const DETECT_TIMEOUT_MS = 3_000;

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function launchOf(value: unknown): AgentLaunch | undefined {
  if (!isFields(value)) return undefined;
  if (
    value.kind === "native" &&
    typeof value.command === "string" &&
    isStrings(value.args)
  ) {
    return { kind: "native", command: value.command, args: value.args };
  }
  if (
    value.kind === "adapter" &&
    typeof value.package === "string" &&
    typeof value.version === "string" &&
    (value.args === undefined || isStrings(value.args))
  ) {
    return {
      kind: "adapter",
      package: value.package,
      version: value.version,
      args: value.args,
    };
  }
  return undefined;
}

function profileOf(value: unknown): AgentProfile | undefined {
  if (!isFields(value)) return undefined;
  const launch = launchOf(value.launch);
  const { id, name, binary } = value;
  if (!launch || typeof id !== "string" || typeof name !== "string") return undefined;
  if (typeof binary !== "string" || id === "") return undefined;
  return { id, name, launch, binary };
}

/** Built-ins plus the user's own `agents.json`, which only this computer's user edits. */
export async function loadProfiles(file: string): Promise<readonly AgentProfile[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return AGENT_PROFILES;
    throw error;
  }
  const listed: unknown = JSON.parse(text);
  if (!Array.isArray(listed))
    throw new Error(`${file} must hold a JSON array of agent profiles.`);
  const own = listed.map((entry, at) => {
    const profile = profileOf(entry);
    if (!profile) throw new Error(`${file}: entry ${at + 1} is not an agent profile.`);
    return profile;
  });
  const ids = new Set(own.map((profile) => profile.id));
  return [...AGENT_PROFILES.filter((profile) => !ids.has(profile.id)), ...own];
}

function versionOf(binary: string, path: string): Promise<string | "missing" | "broken"> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      { timeout: DETECT_TIMEOUT_MS, env: { ...process.env, PATH: path } },
      (error, stdout) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
          resolve("missing");
        else if (error) resolve("broken");
        else resolve(stdout.trim());
      },
    );
  });
}

/** What `hostReport` sends: the installed agents; one that is not installed is left out. */
export async function detectAgents(
  profiles: readonly AgentProfile[],
): Promise<AgentInfo[]> {
  const path = await agentPath();
  const found = await Promise.all(
    profiles.map(async (profile): Promise<AgentInfo | undefined> => {
      const output = await versionOf(profile.binary, path);
      if (output === "missing") return undefined;
      if (output === "broken") {
        return {
          id: profile.id,
          name: profile.name,
          ready: false,
          problem: `\`${profile.binary} --version\` failed: check that ${profile.name} runs in a terminal.`,
        };
      }
      const version = /\d+\.\d+\.\d+[\w.-]*/.exec(output)?.[0];
      return {
        id: profile.id,
        name: profile.name,
        ready: true,
        ...(version ? { version } : {}),
      };
    }),
  );
  return found.filter((agent): agent is AgentInfo => agent !== undefined);
}
