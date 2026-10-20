import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acpLauncher,
  type AgentAskAnswer,
  type AgentConnection,
  type AgentUpdate,
  type AgentAsk,
} from "./acp.js";
import { type FakeAgentScript, fakeAgentProfile } from "./testing/fake-agent.js";

const ENTRY = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));

const script: FakeAgentScript = {
  steps: {
    stream: [
      { kind: "thought", text: "thinking" },
      { kind: "reply", chunks: Array.from({ length: 40 }, (_, n) => `c${n} `) },
      { kind: "tool", title: "ls", toolKind: "read", askPermission: false },
      {
        kind: "tool",
        title: "mcp__hello__createTask",
        toolKind: "other",
        mcp: { server: "hello", tool: "createTask" },
        askPermission: false,
      },
      { kind: "plan", entries: ["one", "two"] },
      { kind: "reply", chunks: ["end"] },
    ],
    ask: [
      { kind: "tool", title: "rm -rf build", toolKind: "execute", askPermission: true },
      { kind: "tool", title: "date", toolKind: "execute", askPermission: true },
      {
        kind: "tool",
        title: "date | tee ~/c5-date.txt",
        toolKind: "execute",
        askPermission: true,
        askTitle: "Run command",
      },
      {
        kind: "tool",
        title: "touch notes.txt",
        toolKind: "execute",
        askPermission: true,
        askTitle: "Run touch notes.txt",
      },
    ],
    cancel: [{ kind: "reply", chunks: ["partial"] }, { kind: "wait_for_cancel" }],
    exit: [
      { kind: "reply", chunks: ["bye"] },
      { kind: "exit", code: 3 },
    ],
  },
};

let dir: string;
let scriptFile: string;
const launched: AgentConnection[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-acp-"));
  scriptFile = join(dir, "script.json");
  await writeFile(scriptFile, JSON.stringify(script));
});

afterAll(async () => {
  await Promise.all(launched.map((connection) => connection.kill()));
  await rm(dir, { recursive: true, force: true });
});

async function launch(): Promise<AgentConnection> {
  const connection = await acpLauncher().launch(fakeAgentProfile(ENTRY, scriptFile), {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    signal: new AbortController().signal,
  });
  launched.push(connection);
  return connection;
}

const prompt = (text: string) => [{ kind: "text" as const, text }];

describe("acpLauncher against the fake agent over real stdio", () => {
  it("delivers every update in wire order before the prompt settles", async () => {
    const connection = await launch();
    const session = await connection.openSession({
      cwd: dir,
      mcpServers: [],
      pinAskMode: true,
    });
    const updates: AgentUpdate[] = [];
    const stop = await session.prompt(prompt("stream"), {
      update: (update) => updates.push(update),
      ask: async () => ({ kind: "cancelled" }),
    });
    expect(stop).toBe("end_turn");
    expect(updates.map((update) => update.kind)).toEqual([
      "thought",
      ...Array<string>(40).fill("text"),
      "tool_start",
      "tool_update",
      "tool_start",
      "tool_update",
      "plan",
      "text",
    ]);
    const texts = updates.flatMap((update) =>
      update.kind === "text" ? [update.text] : [],
    );
    expect(texts.map((text) => text.replace(/^\[t:\d+\]/, ""))).toEqual([
      ...Array.from({ length: 40 }, (_, n) => `c${n} `),
      "end",
    ]);
    expect(updates.at(-5)).toEqual({
      kind: "tool_update",
      toolCallId: "tool-1",
      title: undefined,
      status: "completed",
      detail: undefined,
    });
    expect(updates.at(-4)).toEqual({
      kind: "tool_start",
      toolCallId: "tool-2",
      title: "createTask",
      toolKind: "other",
      mcp: { server: "hello", tool: "createTask" },
    });
  });

  it("asks through handlers.ask and answers the agent with the chosen option", async () => {
    const connection = await launch();
    const session = await connection.openSession({
      cwd: dir,
      mcpServers: [],
      pinAskMode: true,
    });
    const asks: AgentAsk[] = [];
    const answers: AgentAskAnswer[] = [
      { kind: "declined" },
      { kind: "selected", optionId: "allow" },
      { kind: "selected", optionId: "allow" },
      { kind: "selected", optionId: "allow" },
    ];
    const updates: AgentUpdate[] = [];
    await session.prompt(prompt("ask"), {
      update: (update) => updates.push(update),
      ask: async (ask) => {
        asks.push(ask);
        return answers.shift()!;
      },
    });
    expect(asks).toEqual([
      {
        kind: "permission",
        toolCallId: "tool-1",
        title: "rm -rf build",
        toolKind: "execute",
        mcp: undefined,
        options: [
          { id: "allow", label: "Allow", effect: "allow_once" },
          { id: "reject", label: "Reject", effect: "reject_once" },
        ],
      },
      expect.objectContaining({ toolCallId: "tool-2", title: "date" }),
      expect.objectContaining({
        toolCallId: "tool-3",
        title: "Run command: date | tee ~/c5-date.txt",
      }),
      expect.objectContaining({ toolCallId: "tool-4", title: "Run touch notes.txt" }),
    ]);
    const ends = updates.flatMap((update) =>
      update.kind === "tool_update" ? [[update.toolCallId, update.status]] : [],
    );
    expect(ends).toEqual([
      ["tool-1", "failed"],
      ["tool-2", "completed"],
      ["tool-3", "completed"],
      ["tool-4", "completed"],
    ]);
  });

  it("stops the agent on cancel and keeps what it already said", async () => {
    const connection = await launch();
    const session = await connection.openSession({
      cwd: dir,
      mcpServers: [],
      pinAskMode: true,
    });
    const texts: string[] = [];
    const stopped = session.prompt(prompt("cancel"), {
      update: (update) => {
        if (update.kind !== "text") return;
        texts.push(update.text);
        void session.cancel();
      },
      ask: async () => ({ kind: "cancelled" }),
    });
    expect(await stopped).toBe("cancelled");
    expect(texts).toHaveLength(1);
  });

  it("reports an agent that exits mid-turn", async () => {
    const connection = await launch();
    const session = await connection.openSession({
      cwd: dir,
      mcpServers: [],
      pinAskMode: true,
    });
    const prompted = session.prompt(prompt("exit"), {
      update: () => undefined,
      ask: async () => ({ kind: "cancelled" }),
    });
    await expect(prompted).rejects.toThrow();
    expect(await connection.exited).toEqual({ kind: "exited", code: 3, stderrTail: "" });
  });

  it("kills the whole process group", async () => {
    const connection = await launch();
    await connection.kill();
    expect(await connection.exited).toEqual({ kind: "killed" });
  });

  it("never runs an agent through a shell", async () => {
    const marker = join(dir, "pwned");
    const launching = acpLauncher().launch(
      {
        id: "evil",
        name: "Evil",
        launch: { kind: "native", command: `node --version; touch ${marker}`, args: [] },
        binary: "node",
      },
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        signal: new AbortController().signal,
      },
    );
    await expect(launching).rejects.toThrow(/Evil did not start/);
    expect(existsSync(marker)).toBe(false);
  });
});
