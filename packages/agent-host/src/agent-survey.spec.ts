import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acpLauncher } from "./acp.js";
import { readUsage, surveyOptions } from "./agent-survey.js";
import type { AgentProfile } from "./agents.js";

const FAKE = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));
const OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    current: "gpt-a",
    values: [
      { id: "gpt-a", name: "A" },
      { id: "gpt-b", name: "B" },
    ],
  },
];

let dir: string;
const env = { PATH: process.env.PATH ?? "" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-survey-spec-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fakeAgent = async (options: unknown): Promise<AgentProfile> => {
  const script = join(dir, `script-${Math.random()}.json`);
  await writeFile(script, JSON.stringify({ advertise: { options }, steps: {} }));
  return {
    id: "fake",
    name: "Fake",
    launch: { kind: "native", command: process.execPath, args: [FAKE, script] },
    binary: process.execPath,
  };
};

describe("what an agent offers before its first turn", () => {
  it("is read off a session opened only for that, with no prompt", async () => {
    const log = join(dir, "agent.log");
    const profile = await fakeAgent(OPTIONS);
    const options = await surveyOptions(profile, acpLauncher(), {
      ...env,
      FAKE_AGENT_LOG: log,
    });
    expect(options).toEqual(OPTIONS);
    const methods = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toContain("session/new");
    expect(methods).not.toContain("session/prompt");
  }, 30_000);

  it("is nothing when the agent cannot be started", async () => {
    const profile: AgentProfile = {
      id: "missing",
      name: "Missing",
      launch: { kind: "native", command: join(dir, "no-such-agent"), args: [] },
      binary: join(dir, "no-such-agent"),
    };
    expect(await surveyOptions(profile, acpLauncher(), env)).toBeUndefined();
  }, 30_000);
});

describe("the allowance an agent's ACP adapter does not carry", () => {
  it("asks Codex's own app-server, which costs no turn", async () => {
    const codex = join(dir, "codex");
    await writeFile(
      codex,
      `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (process.argv[2] !== "app-server") process.exit(1);
  if (message.method === "initialize") reply({ userAgent: "codex" });
  if (message.method === "account/rateLimits/read")
    reply({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2000000000 } } });
});
`,
    );
    await chmod(codex, 0o755);
    const profile: AgentProfile = {
      id: "codex",
      name: "Codex",
      launch: { kind: "native", command: codex, args: [] },
      binary: codex,
    };
    expect(await readUsage(profile, env, 5)).toEqual({
      windows: [{ id: "primary", minutes: 300, used: 0.4, resetsAt: 2_000_000_000_000 }],
      at: 5,
    });
    expect(await readUsage({ ...profile, id: "claude" }, env, 5)).toBeUndefined();
    expect(
      await readUsage({ ...profile, binary: join(dir, "no-such-codex") }, env, 5),
    ).toBeUndefined();
  }, 30_000);
});
