import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeAgentSkills, skillOf, writeAgentSkills } from "./agent-skills.js";

const app = {
  name: "coursekit",
  appName: "CourseKit",
  appOrigin: "https://courses.example.com",
  account: "alice@example.com",
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "skills-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const skillAt = (...parts: string[]) => join(home, ...parts, "coursekit", "SKILL.md");

describe("agent skills", () => {
  it("writes the app's skill where Claude Code and Codex read user skills", async () => {
    await writeAgentSkills(["claude", "codex", "gemini"], app, { HOME: home });
    for (const at of [skillAt(".claude", "skills"), skillAt(".codex", "skills")]) {
      expect(await readFile(at, "utf8")).toBe(skillOf(app));
    }
    expect(existsSync(join(home, ".gemini"))).toBe(false);
  });

  it("follows CODEX_HOME and CLAUDE_CONFIG_DIR", async () => {
    const env = {
      HOME: home,
      CODEX_HOME: join(home, "codex-home"),
      CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    };
    await writeAgentSkills(["claude", "codex"], app, env);
    expect(existsSync(skillAt("codex-home", "skills"))).toBe(true);
    expect(existsSync(skillAt("claude-config", "skills"))).toBe(true);
  });

  it("names the app, its tools and its account, and sends the agent to the tools before a browser", () => {
    const skill = skillOf(app);
    expect(skill).toMatch(
      /^---\nname: coursekit\ndescription: "Use whenever the user names CourseKit or \\"coursekit\\"/,
    );
    expect(skill).toContain("at https://courses.example.com as alice@example.com");
    expect(skill).toContain("instead of opening the app in a browser");
    expect(skill).toContain('search your tools for "coursekit" first');
  });

  it("never replaces or removes a skill of the same name the user wrote", async () => {
    const own = skillAt(".codex", "skills");
    await mkdir(join(own, ".."), { recursive: true });
    await writeFile(own, "my own coursekit skill");

    await writeAgentSkills(["codex"], app, { HOME: home });
    expect(await readFile(own, "utf8")).toBe("my own coursekit skill");
    await removeAgentSkills(["codex"], "coursekit", { HOME: home });
    expect(await readFile(own, "utf8")).toBe("my own coursekit skill");
  });

  it("writes nothing into a skills folder the user links in from elsewhere", async () => {
    const dotfiles = join(home, "dotfiles", "skills");
    await mkdir(dotfiles, { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await symlink(dotfiles, join(home, ".claude", "skills"));
    await mkdir(join(home, "linked-codex"), { recursive: true });
    await symlink(join(home, "linked-codex"), join(home, ".codex"));

    await writeAgentSkills(["claude", "codex"], app, { HOME: home });
    expect(existsSync(join(dotfiles, "coursekit"))).toBe(false);
    expect(existsSync(join(home, "linked-codex", "skills"))).toBe(false);
  });

  it("refreshes its own skill, and removes it with the app", async () => {
    await writeAgentSkills(["claude"], app, { HOME: home });
    await writeAgentSkills(
      ["claude"],
      { ...app, account: "bob@example.com" },
      { HOME: home },
    );
    expect(await readFile(skillAt(".claude", "skills"), "utf8")).toContain(
      "as bob@example.com",
    );

    await removeAgentSkills(["claude"], "coursekit", { HOME: home });
    expect(existsSync(join(home, ".claude", "skills", "coursekit"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
  });
});
