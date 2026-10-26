import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentOption, AgentUsage } from "@parlor/chat";

import type { AgentLauncher } from "./acp.js";
import { codexUsageOf } from "./agent-options.js";
import type { AgentProfile } from "./agents.js";
import { askCodex } from "./codex-app-server.js";

const SURVEY_TIMEOUT_MS = 60_000;

/**
 * The options `profile` offers, from a session opened in a scratch directory only to read
 * them and then closed: no prompt, so no model turn. Lets the sidebar offer a model before
 * the agent's first turn. Undefined when the agent cannot be started or is not logged in.
 */
export async function surveyOptions(
  profile: AgentProfile,
  launcher: AgentLauncher,
  env: Readonly<Record<string, string>>,
  stop?: AbortSignal,
): Promise<readonly AgentOption[] | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), "parlor-survey-"));
  const timeout = AbortSignal.timeout(SURVEY_TIMEOUT_MS);
  const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
  try {
    const connection = await launcher.launch(profile, { cwd, env, signal });
    const end = () => void connection.kill();
    signal.addEventListener("abort", end, { once: true });
    try {
      if (!connection.capabilities.ready) return undefined;
      const session = await connection.openSession({
        cwd,
        mcpServers: [],
        pinAskMode: true,
      });
      return session.options;
    } finally {
      signal.removeEventListener("abort", end);
      await connection.kill();
    }
  } catch {
    return undefined;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * The account's allowance from the agent's own CLI, for an agent whose ACP adapter does not
 * carry it: `codex-acp` drops Codex's rate limits. Claude Code sends its own over ACP.
 */
export async function readUsage(
  profile: AgentProfile,
  env: Readonly<Record<string, string>>,
  now: number,
): Promise<AgentUsage | undefined> {
  if (profile.id !== "codex") return undefined;
  return codexUsageOf(
    await askCodex(profile.binary, "account/rateLimits/read", null, env),
    now,
  );
}
