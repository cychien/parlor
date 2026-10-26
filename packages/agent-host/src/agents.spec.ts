import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_PROFILES,
  type AgentProfile,
  detectAgents,
  findAgents,
  loadProfiles,
} from "./agents.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-agents-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fake: AgentProfile = {
  id: "fake",
  name: "Fake agent",
  launch: {
    kind: "native",
    command: "/usr/local/bin/node",
    args: ["/abs/fake-agent.mjs", "/abs/p1.json"],
  },
  binary: "node",
};

describe("agent profiles", () => {
  it("pins Claude Code and Codex to exact adapter versions", () => {
    expect(AGENT_PROFILES.slice(0, 2)).toEqual([
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
        apps: ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"],
      },
    ]);
  });

  it("adds the user's own profiles from a JSON array, theirs winning on the same id", async () => {
    const file = join(dir, "agents.json");
    const ownClaude = { ...AGENT_PROFILES[0]!, name: "My Claude" };
    await writeFile(file, JSON.stringify([fake, ownClaude]));
    const profiles = await loadProfiles(file);
    expect(profiles.map((profile) => profile.id)).toEqual([
      "codex",
      "gemini",
      "fake",
      "claude",
    ]);
    expect(profiles.find((profile) => profile.id === "claude")?.name).toBe("My Claude");
    expect(await loadProfiles(join(dir, "absent.json"))).toBe(AGENT_PROFILES);
  });

  it("refuses a file that is not a list of profiles", async () => {
    const file = join(dir, "bad.json");
    await writeFile(file, JSON.stringify(fake));
    await expect(loadProfiles(file)).rejects.toThrow(/JSON array/);
    await writeFile(file, JSON.stringify([{ id: "x", name: "X" }]));
    await expect(loadProfiles(file)).rejects.toThrow(/entry 1/);
  });

  it("lists installed agents with their version, explains a broken one and leaves out a missing one", async () => {
    const broken = join(dir, "broken-agent");
    await writeFile(broken, "#!/bin/sh\nexit 3\n");
    await chmod(broken, 0o755);
    const agents = await detectAgents([
      fake,
      { ...fake, id: "broken", name: "Broken", binary: broken },
      { ...fake, id: "missing", name: "Missing", binary: "parlor-no-such-agent" },
    ]);
    expect(agents).toEqual([
      { id: "fake", name: "Fake agent", ready: true, version: process.versions.node },
      {
        id: "broken",
        name: "Broken",
        ready: false,
        problem: `\`${broken} --version\` failed: check that Broken runs in a terminal.`,
      },
    ]);
  }, 30_000);

  it("runs the CLI a desktop app ships when none is on the PATH, and the PATH's when both are", async () => {
    const shipped = join(dir, "App.app", "cli");
    await mkdir(join(dir, "App.app"), { recursive: true });
    await writeFile(shipped, '#!/bin/sh\necho "app-cli 2.0.0"\n');
    await chmod(shipped, 0o755);
    const found = await findAgents([
      { ...fake, id: "onPath", apps: [shipped] },
      {
        ...fake,
        id: "inApp",
        binary: "parlor-no-such-agent",
        apps: [join(dir, "gone"), shipped],
      },
      {
        ...fake,
        id: "nowhere",
        binary: "parlor-no-such-agent",
        apps: [join(dir, "gone")],
      },
    ]);
    expect(found.agents.map(({ id, version }) => [id, version])).toEqual([
      ["onPath", process.versions.node],
      ["inApp", "2.0.0"],
    ]);
    expect(found.profiles.map(({ id, binary }) => [id, binary])).toEqual([
      ["onPath", "node"],
      ["inApp", shipped],
      ["nowhere", "parlor-no-such-agent"],
    ]);
  }, 30_000);
});
