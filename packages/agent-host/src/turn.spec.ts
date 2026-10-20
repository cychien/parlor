import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ClaimedTurn,
  HostFrame,
  HostItemDraft,
  LoggedItem,
  TurnOutcome,
  TurnSignals,
} from "@parlor/chat";
import { asId, type ThreadId } from "@parlor/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { acpLauncher } from "./acp.js";
import type { AppGrant } from "./grants.js";
import type { AppLink } from "./link.js";
import { createMcpProxy, type McpProxy } from "./mcp-proxy.js";
import { DEV_POLICY } from "./policy.js";
import { createSessionPool, type SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import { type FakeAgentScript, fakeAgentProfile } from "./testing/fake-agent.js";
import { runTurn, type TurnDeps } from "./turn.js";

const ENTRY = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));
const CONTEXT = "<parlor-context>You work for Alice in Hello.</parlor-context>";

const script: FakeAgentScript = {
  fallback: "echo",
  steps: {
    slow: [
      {
        kind: "reply",
        chunks: Array.from({ length: 200 }, () => "slow "),
        perSecond: 20,
      },
    ],
    cancellable: [
      {
        kind: "reply",
        chunks: Array.from({ length: 300 }, () => "abcde"),
        perSecond: 100,
      },
      { kind: "wait_for_cancel" },
    ],
    scripted: [
      { kind: "thought", text: "Checking the clock." },
      { kind: "reply", chunks: ["Let me ", "check."] },
      { kind: "tool", title: "date", toolKind: "execute", askPermission: true },
      { kind: "reply", chunks: ["It is late."] },
    ],
    crash: [
      { kind: "reply", chunks: ["Starting"] },
      { kind: "exit", code: 7 },
    ],
  },
};

type Logged =
  | {
      readonly kind: "stream";
      readonly at: number;
      readonly frames: readonly HostFrame[];
    }
  | {
      readonly kind: "append";
      readonly at: number;
      readonly items: readonly HostItemDraft[];
    }
  | { readonly kind: "finish"; readonly at: number; readonly outcome: TurnOutcome };

let dir: string;
let proxy: McpProxy;
let pool: SessionPool;
let agentLog: string;

const grant: AppGrant = {
  appOrigin: "http://localhost:5301",
  appName: "Hello",
  grantId: asId("grant", "host:g1"),
  hostId: asId("host", "h1"),
  account: { userId: asId("user", "alice"), name: "Alice", email: "alice@example.com" },
  workspace: "",
  createdAt: 1,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-turn-"));
  agentLog = join(dir, "agent.log");
  vi.stubEnv("FAKE_AGENT_LOG", agentLog);
  await writeFile(join(dir, "script.json"), JSON.stringify(script));
  proxy = createMcpProxy("parlor-host");
  await proxy.listen(join(dir, "run", "proxy.sock"));
  pool = createSessionPool(join(dir, "sessions.json"));
});

afterAll(async () => {
  await pool.drop(grant.appOrigin);
  await proxy.close();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

interface AgentLogEntry {
  readonly at: number;
  readonly method: string;
  readonly pid: number;
  readonly text?: string;
}

const agentLogEntries = (): AgentLogEntry[] =>
  readFileSync(agentLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentLogEntry);

function harness(signals: (afterSeq: number) => TurnSignals[] = () => []) {
  const logged: Logged[] = [];
  const now = () => Date.now();
  const calls = {
    call: async (name: string, input: Record<string, unknown>) => {
      switch (name) {
        case "hostAppend":
          logged.push({
            kind: "append",
            at: now(),
            items: input.items as HostItemDraft[],
          });
          return {
            id: "t1",
            leaseUntil: now() + 60_000,
            token: { token: `renewed-${logged.length}`, expiresAt: now() + 60_000 },
          };
        case "hostFinish":
          logged.push({
            kind: "finish",
            at: now(),
            outcome: input.outcome as TurnOutcome,
          });
          return { id: "t1" };
        case "hostSignals":
          return signals((input.turns as { afterSeq: number }[])[0]!.afterSeq);
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  };
  const link = {
    grant: { ...grant, workspace: dir },
    protocol: 1,
    start: () => undefined,
    stop: async () => undefined,
    api: {
      calls: { ...calls, invoke: async () => ({ data: undefined, tags: [] }) },
      stream: (batch: { readonly frames: readonly HostFrame[] }) =>
        logged.push({ kind: "stream", at: now(), frames: batch.frames }),
      heartbeat: async () => undefined,
    },
  } as unknown as AppLink;
  const prompter: LocalPrompter = {
    confirmPairing: async () => false,
    approveDevice: async () => false,
    answerHere: async () => undefined,
    turnStarted: () => undefined,
  };
  const deps: TurnDeps = {
    link,
    profiles: [
      {
        ...fakeAgentProfile(ENTRY, join(dir, "script.json")),
        id: "fake-a",
        name: "Fake A",
      },
      {
        ...fakeAgentProfile(ENTRY, join(dir, "script.json")),
        id: "fake-b",
        name: "Fake B",
      },
    ],
    launcher: acpLauncher(),
    pool,
    proxy,
    policy: DEV_POLICY,
    prompter,
    now,
  };
  const appended = () =>
    logged.flatMap((entry) => (entry.kind === "append" ? entry.items : []));
  const streamedText = () =>
    logged
      .flatMap((entry) => (entry.kind === "stream" ? entry.frames : []))
      .map((frame) => (frame.type === "delta" ? frame.text : ""))
      .join("");
  return { deps, logged, appended, streamedText };
}

let turns = 0;
function claim(threadId: ThreadId, agentId: string, text: string): ClaimedTurn {
  turns += 1;
  const turnId = asId("turn", `u${turns}`);
  const prompt: LoggedItem<"prompt"> = {
    id: asId("item", `p${turns}`),
    threadId,
    turnId,
    seq: turns * 10,
    at: Date.now(),
    author: "user",
    kind: "prompt",
    body: { text, agent: { hostId: asId("host", "h1"), agentId } },
  };
  return {
    id: threadId,
    turnId,
    agent: { hostId: asId("host", "h1"), agentId },
    clientId: "tab-1",
    prompt,
    device: undefined,
    context: CONTEXT,
    token: { token: `turn-${turns}`, expiresAt: Date.now() + 60_000 },
    leaseUntil: Date.now() + 60_000,
  };
}

const prompts = () =>
  agentLogEntries().filter((entry) => entry.method === "session/prompt");

describe("runTurn against the fake agent over real stdio", () => {
  it("C12: an agent killed mid-turn ends the turn, the next one relaunches with context, a switch says so", async () => {
    const thread = asId("thread", "c12");
    const first = harness();
    const running = runTurn(claim(thread, "fake-a", "slow"), first.deps);
    await vi.waitFor(() => expect(first.streamedText().length).toBeGreaterThan(20), {
      timeout: 10_000,
    });
    const victim = prompts().at(-1)!.pid;
    process.kill(-victim, "SIGKILL");
    const killedAt = Date.now();
    expect(await running).toEqual({ state: "failed", reason: "agent_exited" });
    const finished = first.logged.find((entry) => entry.kind === "finish")!;
    expect(finished).toMatchObject({
      outcome: { state: "failed", reason: "agent_exited" },
    });
    expect(finished.at - killedAt).toBeLessThanOrEqual(5_000);
    expect(first.appended().filter((item) => item.kind === "event")).toEqual([
      expect.objectContaining({
        kind: "event",
        body: expect.objectContaining({ event: "agent_exited" }),
      }),
    ]);

    const second = harness();
    expect(await runTurn(claim(thread, "fake-a", "hello"), second.deps)).toMatchObject({
      state: "done",
    });
    const relaunched = prompts().at(-1)!;
    expect(relaunched.pid).not.toBe(victim);
    expect(relaunched.text!.startsWith(CONTEXT)).toBe(true);

    const third = harness();
    expect(
      await runTurn(claim(thread, "fake-b", "hello again"), third.deps),
    ).toMatchObject({
      state: "done",
    });
    expect(third.appended()[0]).toMatchObject({
      kind: "event",
      body: { event: "agent_switched" },
    });
    const switched = prompts().at(-1)!;
    expect(switched.pid).not.toBe(relaunched.pid);
    expect(switched.text!.startsWith(CONTEXT)).toBe(true);
  }, 30_000);

  it("C13: cancel sends session/cancel within 1 s and keeps the partial reply", async () => {
    const thread = asId("thread", "c13");
    let cancelReturnedAt: number | undefined;
    const run = harness((afterSeq) => {
      if (cancelReturnedAt !== undefined || run.streamedText().length < 100) return [];
      cancelReturnedAt = Date.now();
      return [
        {
          turnId: asId("turn", `u${turns}`),
          items: [
            {
              id: asId("item", "c1"),
              threadId: thread,
              turnId: asId("turn", `u${turns}`),
              seq: afterSeq + 1,
              at: Date.now(),
              author: "user",
              kind: "cancel",
              body: {},
            },
          ],
        },
      ];
    });
    expect(await runTurn(claim(thread, "fake-a", "cancellable"), run.deps)).toEqual({
      state: "cancelled",
    });
    const cancelAt = agentLogEntries().find(
      (entry) => entry.method === "session/cancel",
    )!.at;
    expect(cancelAt - cancelReturnedAt!).toBeLessThanOrEqual(1_000);

    const reply = run.appended().find((item) => item.kind === "reply")!;
    expect(reply.body).toEqual({ text: run.streamedText(), interrupted: true });
    const replyAppend = run.logged.findIndex(
      (entry) =>
        entry.kind === "append" && entry.items.some((item) => item.id === reply.id),
    );
    const lateFrames = run.logged
      .slice(replyAppend)
      .flatMap((entry) => (entry.kind === "stream" ? entry.frames : []))
      .filter((frame) => frame.type === "delta" && frame.itemId === reply.id);
    expect(lateFrames).toEqual([]);
    expect(run.logged.at(-1)).toMatchObject({
      kind: "finish",
      outcome: { state: "cancelled" },
    });

    const again = harness();
    expect(await runTurn(claim(thread, "fake-a", "once more"), again.deps)).toMatchObject(
      {
        state: "done",
      },
    );
  }, 30_000);

  it("T4-05: plays the scripted items in order, routes the ask to the chat and its answer to the agent", async () => {
    const thread = asId("thread", "t405");
    let answered = false;
    const run = harness((afterSeq) => {
      const ask = run.appended().find((item) => item.kind === "ask");
      if (!ask || answered) return [];
      answered = true;
      const turnId = asId("turn", `u${turns}`);
      return [
        {
          turnId,
          items: [
            {
              id: asId("item", "a1"),
              threadId: thread,
              turnId,
              seq: afterSeq + 1,
              at: Date.now(),
              author: "user",
              kind: "answer",
              body: { askId: ask.id, choice: "allow" },
            },
          ],
        },
      ];
    });
    const turn = claim(thread, "fake-a", "scripted");
    expect(await runTurn(turn, run.deps)).toEqual({
      state: "done",
      stopReason: "end_turn",
    });
    const items = run.appended().map((item) => ({ id: item.id, kind: item.kind }));
    expect(items).toEqual([
      { id: `${turn.turnId}.1`, kind: "reasoning" },
      { id: `${turn.turnId}.2`, kind: "reply" },
      { id: `${turn.turnId}.4`, kind: "ask" },
      { id: `${turn.turnId}.3`, kind: "tool" },
      { id: `${turn.turnId}.5`, kind: "reply" },
    ]);
    const ask = run.appended().find((item) => item.kind === "ask")!;
    expect(ask.body).toEqual({
      question: "date",
      choices: [
        { id: "allow", label: "Allow", effect: "allow_once" },
        { id: "reject", label: "Reject", effect: "reject_once" },
      ],
    });
    expect(run.appended().find((item) => item.kind === "tool")!.body).toMatchObject({
      title: "date",
      status: "done",
    });

    const crash = harness();
    expect(await runTurn(claim(thread, "fake-a", "crash"), crash.deps)).toEqual({
      state: "failed",
      reason: "agent_exited",
    });
    expect(crash.appended().at(-1)).toMatchObject({
      kind: "event",
      body: { event: "agent_exited", detail: "exit code 7" },
    });
  }, 30_000);
});
