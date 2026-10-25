import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentNames,
  agentToolsName,
  registerAgentTools,
  unregisterAgentTools,
} from "./agent-tools.js";
import type { AgentProfile } from "./agents.js";

let dir: string;
let profiles: AgentProfile[];
const HOST = "/Users/alice/.parlor/host/bin/parlor-host";

const fakeCli = async (id: string, failing = false) => {
  const binary = join(dir, id);
  await writeFile(
    binary,
    `#!/bin/sh\necho "$@" >> "${join(dir, `${id}.log`)}"\n${failing ? "exit 1\n" : ""}`,
  );
  await chmod(binary, 0o755);
  return binary;
};

const calls = async (id: string) =>
  (await readFile(join(dir, `${id}.log`), "utf8").catch(() => "")).trim().split("\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-agent-tools-"));
  profiles = [
    {
      id: "claude",
      name: "Claude Code",
      binary: await fakeCli("claude"),
      launch: { kind: "native", command: "x", args: [] },
    },
    {
      id: "codex",
      name: "Codex",
      binary: await fakeCli("codex"),
      launch: { kind: "native", command: "x", args: [] },
    },
    {
      id: "gemini",
      name: "Gemini",
      binary: await fakeCli("gemini"),
      launch: { kind: "native", command: "x", args: [] },
    },
  ];
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const deps = () => ({
  profiles,
  hostCommand: HOST,
  env: async () => ({ PATH: process.env.PATH ?? "" }),
});

describe("handing an app to the coding agents on this computer", () => {
  it("names a deployed app by its name, and a local one by its host beside it", () => {
    expect(agentToolsName("CourseKit", "https://school.example.com")).toBe("coursekit");
    expect(agentToolsName("CourseKit", "http://localhost:7001")).toBe(
      "coursekit-localhost-7001",
    );
    expect(agentToolsName("My App!", "https://staging.example.com:8443")).toBe(
      "my-app-staging-example-com-8443",
    );
  });

  it("registers it user-wide with every agent that has a CLI for it, replacing an older entry", async () => {
    const tools = await registerAgentTools(deps(), {
      appName: "CourseKit",
      appOrigin: "http://localhost:7001",
    });
    expect(tools).toEqual({
      name: "coursekit-localhost-7001",
      agents: ["claude", "codex"],
    });
    const command = `${HOST} mcp-proxy --app http://localhost:7001`;
    expect(await calls("claude")).toEqual([
      "mcp remove --scope user coursekit-localhost-7001",
      `mcp add --scope user coursekit-localhost-7001 -- ${command}`,
    ]);
    expect(await calls("codex")).toEqual([
      "mcp remove coursekit-localhost-7001",
      `mcp add coursekit-localhost-7001 -- ${command}`,
    ]);
    expect(await calls("gemini")).toEqual([""]);
    expect(agentNames(profiles, tools)).toBe("Claude Code and Codex");

    await unregisterAgentTools(deps(), tools);
    expect((await calls("claude")).at(-1)).toBe(
      "mcp remove --scope user coursekit-localhost-7001",
    );
    expect((await calls("codex")).at(-1)).toBe("mcp remove coursekit-localhost-7001");
  });

  it("leaves out an agent whose CLI refused it", async () => {
    const refusing = { ...profiles[1]!, binary: await fakeCli("codex-broken", true) };
    const tools = await registerAgentTools(
      { ...deps(), profiles: [profiles[0]!, refusing] },
      { appName: "Hello", appOrigin: "https://hello.example" },
    );
    expect(tools).toEqual({ name: "hello", agents: ["claude"] });
    expect(agentNames(profiles, tools)).toBe("Claude Code");
  });
});
