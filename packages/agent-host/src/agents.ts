import type { AgentInfo } from "@parlor/chat";

/** The app picks an agent by `id` only, never by command, so no remote party chooses what runs. */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly launch: AgentLaunch;
  /** The CLI behind it, for the installed-and-logged-in check. */
  readonly binary: string;
}

/**
 * `adapter`: an npm ACP adapter at an exact version, run with the host's embedded
 * runtime. `native`: an agent CLI that speaks ACP itself, found on the login-shell PATH.
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

export const DETECT_TIMEOUT_MS = 3_000;

/** Built-ins plus the user's own `agents.json`, which only this computer's user edits. */
export async function loadProfiles(file: string): Promise<readonly AgentProfile[]> {
  void file;
  throw new Error("not implemented");
}

/** What `hostReport` sends. */
export async function detectAgents(
  profiles: readonly AgentProfile[],
): Promise<AgentInfo[]> {
  // TODO: PATH from the login shell once ($SHELL -ilc), since a LaunchAgent or GUI app
  //   does not inherit it; `<binary> --version` capped at DETECT_TIMEOUT_MS each.
  void profiles;
  throw new Error("not implemented");
}
