import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { commandOf, launchEnvironment } from "./adapter-launch.js";
import { AGENT_PROFILES, type AgentProfile } from "./agents.js";
import { adapterKey, embeddedAdapters } from "./embedded.js";
import { agentPath, resolveBinary } from "./shell-path.js";

const [claude, codex] = AGENT_PROFILES as [AgentProfile, AgentProfile];
const adapterOf = (profile: AgentProfile) => {
  if (profile.launch.kind !== "adapter") throw new Error("not an adapter");
  return profile.launch;
};

afterEach(() => embeddedAdapters.clear());

describe("how an adapter agent is launched", () => {
  it("runs through npx at the pinned version when the build embeds no adapter", () => {
    expect(commandOf(claude)).toEqual({
      command: "npx",
      args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.93.0"],
    });
  });

  it("C8: runs the embedded adapter by re-executing this program, with no npx", () => {
    embeddedAdapters.set(adapterKey(adapterOf(claude)), "claude");
    embeddedAdapters.set(adapterKey(adapterOf(codex)), "codex");
    const first = commandOf(claude);
    const second = commandOf(codex);
    expect(first.command).toBe(process.execPath);
    expect(first.args.slice(-2)).toEqual(["adapter", "claude"]);
    expect(second.args.slice(-2)).toEqual(["adapter", "codex"]);
    expect(first.command).not.toBe("npx");
  });

  it("does not run the embedded adapter for a profile that names another package or version", () => {
    embeddedAdapters.set(adapterKey(adapterOf(claude)), "claude");
    const mine: AgentProfile = {
      ...claude,
      launch: { kind: "adapter", package: "my-claude-adapter", version: "1.0.0" },
    };
    const newer: AgentProfile = {
      ...claude,
      launch: { ...adapterOf(claude), version: "0.94.0" },
    };
    expect(commandOf(mine).command).toBe("npx");
    expect(commandOf(newer).command).toBe("npx");
  });

  it("launches a native agent by its own command", () => {
    expect(commandOf(AGENT_PROFILES[2]!)).toEqual({ command: "gemini", args: ["--acp"] });
  });
});

describe("where an adapter finds the agent CLI", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "parlor-bin-"));
    await writeFile(join(dir, "claude"), "#!/bin/sh\n");
    await chmod(join(dir, "claude"), 0o755);
    await writeFile(join(dir, "codex"), "not executable");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("C8: names the installed claude for the Claude adapter, because its own search fails in a single executable", async () => {
    expect(await launchEnvironment(claude, { PATH: dir })).toEqual({
      PATH: dir,
      CLAUDE_CODE_EXECUTABLE: join(dir, "claude"),
    });
  });

  it("names codex for the Codex adapter, but only when one is executable", async () => {
    expect(await launchEnvironment(codex, { PATH: dir })).toEqual({ PATH: dir });
    await chmod(join(dir, "codex"), 0o755);
    expect(await launchEnvironment(codex, { PATH: dir })).toEqual({
      PATH: dir,
      CODEX_PATH: join(dir, "codex"),
    });
  });

  it("leaves a path the user set alone, and sets nothing for a native agent", async () => {
    expect(
      await launchEnvironment(claude, {
        PATH: dir,
        CLAUDE_CODE_EXECUTABLE: "/mine/claude",
      }),
    ).toEqual({ PATH: dir, CLAUDE_CODE_EXECUTABLE: "/mine/claude" });
    expect(await launchEnvironment(AGENT_PROFILES[2]!, { PATH: dir })).toEqual({
      PATH: dir,
    });
  });

  it("finds the first executable on the path and none that is missing", async () => {
    expect(await resolveBinary("claude", `/nowhere:${dir}`)).toBe(join(dir, "claude"));
    expect(await resolveBinary("nothing-here", dir)).toBeUndefined();
  });
});

describe("the PATH agents are found on", () => {
  it("C8: keeps the system PATH and adds the directories agent CLIs install into, which launchd leaves out", async () => {
    const path = (await agentPath()).split(":");
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/usr/local/bin");
    expect(path.some((entry) => entry.endsWith("/.local/bin"))).toBe(true);
    expect(path.filter((entry) => entry === "/opt/homebrew/bin")).toHaveLength(1);
  }, 30_000);
});
