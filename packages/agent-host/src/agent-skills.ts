import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { logEvent } from "./log.js";

/** What a skill says about the app it points the agent's MCP tools at. */
export interface SkillApp {
  /** The MCP server name, which is also the skill's name and the word the user asks with. */
  readonly name: string;
  readonly appName: string;
  readonly appOrigin: string;
  /** Whose account the tools act as: an email, or a name. */
  readonly account: string;
}

/**
 * Where each agent reads user-wide skills. Coding agents load MCP tools on demand and list
 * skills up front, so a skill named after the app is what the agent sees when the user
 * names it, instead of a browser skill or a guess.
 */
const SKILL_ROOTS: Readonly<Record<string, (env: Record<string, string>) => string>> = {
  claude: (env) => join(env.CLAUDE_CONFIG_DIR || join(homeOf(env), ".claude"), "skills"),
  codex: (env) => join(env.CODEX_HOME || join(homeOf(env), ".codex"), "skills"),
};

/** Marks a skill directory as Parlor Host's, so a skill the user wrote is never replaced or removed. */
const OWNER_FILE = ".parlor-host";

const homeOf = (env: Record<string, string>) => env.HOME || homedir();

export function skillOf(app: SkillApp): string {
  const description = `Use whenever the user names ${app.appName} or "${app.name}", to read or change anything in ${app.appName} (${app.appOrigin}). Use the ${app.name} MCP tools for it, not a browser.`;
  return `---
name: ${app.name}
description: ${JSON.stringify(description)}
---

# ${app.appName}

The \`${app.name}\` MCP server acts on the live ${app.appName} app at ${app.appOrigin} as ${app.account}. Its tools read and change the same data the app shows, directly.

- For anything the user asks of ${app.appName}, use these tools instead of opening the app in a browser.
- The tools may load on demand: if none from \`${app.name}\` are listed, search your tools for "${app.name}" first.
- Reading is free. Before the first change in a conversation, the user is asked to allow changes.

Parlor Host wrote this skill when this computer was connected to ${app.appName}, and removes it when it is disconnected.
`;
}

async function ownedBy(dir: string): Promise<string | undefined> {
  return readFile(join(dir, OWNER_FILE), "utf8").then(
    (text) => text.trim(),
    () => undefined,
  );
}

/**
 * Whether the user keeps the agent's settings elsewhere and links them in, as dotfiles and
 * home-manager do: a skill written there would land in their own repository or store.
 */
async function linkedIn(root: string): Promise<boolean> {
  for (const path of [root, dirname(root)]) {
    const stat = await lstat(path).catch(() => undefined);
    if (stat?.isSymbolicLink()) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  return readFile(join(path, "SKILL.md")).then(
    () => true,
    () => false,
  );
}

/** Writes or refreshes the app's skill for each agent here; a skill of the same name the user wrote stays. */
export async function writeAgentSkills(
  agents: readonly string[],
  app: SkillApp,
  env: Record<string, string>,
): Promise<void> {
  for (const agent of agents) {
    const root = SKILL_ROOTS[agent];
    if (!root) continue;
    const dir = join(root(env), app.name);
    try {
      if (await linkedIn(root(env))) {
        logEvent("agent_skill_kept", { agent, name: app.name, reason: "linked" });
        continue;
      }
      if ((await exists(dir)) && (await ownedBy(dir)) === undefined) {
        logEvent("agent_skill_kept", { agent, name: app.name });
        continue;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), skillOf(app));
      await writeFile(join(dir, OWNER_FILE), `${app.appOrigin}\n`);
    } catch (error) {
      logEvent("agent_skill_failed", { agent, name: app.name, error: String(error) });
    }
  }
}

/** Removes the skills Parlor Host wrote for the app; one the user wrote under the name stays. */
export async function removeAgentSkills(
  agents: readonly string[],
  name: string,
  env: Record<string, string>,
): Promise<void> {
  for (const agent of agents) {
    const root = SKILL_ROOTS[agent];
    if (!root) continue;
    const dir = join(root(env), name);
    if ((await ownedBy(dir)) === undefined) continue;
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      logEvent("agent_skill_failed", { agent, name, error: String(error) });
    });
  }
}
