import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

import { acpLauncher, type AgentLauncher } from "./acp.js";
import type { AppGrant } from "./grants.js";
import type { AppLink } from "./link.js";
import { createMcpProxy, type McpProxy } from "./mcp-proxy.js";
import { DEV_POLICY } from "./policy.js";
import { createSessionPool, type SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import { type FakeAgentScript, fakeAgentProfile } from "./testing/fake-agent.js";
import { runTurn, type TurnDeps } from "./turn.js";

const ENTRY = fileURLToPath(new URL("../bin/fake-agent.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));
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
    probe: [{ kind: "call_app", tool: "listTasks", input: {} }],
  },
};

const bypassOnly: FakeAgentScript = {
  fallback: "echo",
  advertise: {
    modes: { current: "bypassPermissions", available: ["bypassPermissions"] },
  },
  steps: {},
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
const origins = new Set<string>();

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
  await writeFile(join(dir, "bypass.json"), JSON.stringify(bypassOnly));
  proxy = createMcpProxy("parlor-host");
  await proxy.listen(join(dir, "run", "proxy.sock"));
  pool = createSessionPool(join(dir, "sessions.json"));
});

afterAll(async () => {
  for (const origin of [grant.appOrigin, ...origins]) await pool.drop(origin);
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
  (existsSync(agentLog) ? readFileSync(agentLog, "utf8") : "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentLogEntry);

interface HarnessOptions {
  readonly appOrigin?: string;
  readonly launcher?: AgentLauncher;
  readonly proxy?: McpProxy;
}

let harnesses = 0;

function harness(
  signals: (afterSeq: number) => TurnSignals[] = () => [],
  options: HarnessOptions = {},
) {
  harnesses += 1;
  const issuedBy = `h${harnesses}`;
  const issued: string[] = [];
  const logged: Logged[] = [];
  const now = () => Date.now();
  if (options.appOrigin) origins.add(options.appOrigin);
  const calls = {
    call: async (name: string, input: Record<string, unknown>) => {
      switch (name) {
        case "hostAppend":
          logged.push({
            kind: "append",
            at: now(),
            items: input.items as HostItemDraft[],
          });
          issued.push(`${issuedBy}-renewed-${logged.length}`);
          return {
            id: "t1",
            leaseUntil: now() + 60_000,
            token: { token: issued.at(-1)!, expiresAt: now() + 60_000 },
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
    grant: { ...grant, appOrigin: options.appOrigin ?? grant.appOrigin, workspace: dir },
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
      {
        ...fakeAgentProfile(ENTRY, join(dir, "bypass.json")),
        id: "fake-bypass",
        name: "Fake bypass",
      },
    ],
    launcher: options.launcher ?? acpLauncher(),
    pool,
    proxy: options.proxy ?? proxy,
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
  return { deps, logged, appended, streamedText, issued };
}

let turns = 0;
function claim(
  threadId: ThreadId,
  agentId: string,
  text: string,
  token = `turn-${turns + 1}`,
): ClaimedTurn {
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
    token: { token, expiresAt: Date.now() + 60_000 },
    leaseUntil: Date.now() + 60_000,
  };
}

const prompts = () =>
  agentLogEntries().filter((entry) => entry.method === "session/prompt");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface StubApp {
  readonly origin: string;
  readonly bearers: string[];
  close(): Promise<void>;
}

async function stubMcpApp(): Promise<StubApp> {
  const bearers: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method === "tools/call") {
        bearers.push(request.headers.authorization ?? "");
      }
      if (message.id === undefined) return void response.writeHead(202).end();
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "1" },
            }
          : { content: [{ type: "text", text: "[]" }] };
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bearers,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

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

  it("T4-07: a revocation during a cold launch kills the agent before it gets the prompt", async () => {
    const origin = "http://localhost:5307";
    let started: () => void = () => undefined;
    const launched = new Promise<void>((resolve) => (started = resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const launcher: AgentLauncher = {
      launch: async (profile, options) => {
        const connection = await acpLauncher().launch(profile, options);
        started();
        await gate;
        return connection;
      },
    };
    const run = harness(undefined, { appOrigin: origin, launcher });
    const before = agentLogEntries().length;
    const running = runTurn(claim(asId("thread", "t407"), "fake-a", "hello"), run.deps);
    await launched;
    const pid = agentLogEntries()
      .slice(before)
      .find((entry) => entry.method === "initialize")!.pid;

    await pool.drop(origin);
    release();

    expect(await running).toEqual({ state: "failed", reason: "agent_unavailable" });
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
    expect(
      agentLogEntries()
        .slice(before)
        .filter((entry) => entry.method === "session/prompt"),
    ).toEqual([]);
    expect(pool.process(origin, "fake-a")).toBeUndefined();
  }, 30_000);

  it("T4-08: two threads starting one agent at once share one process", async () => {
    const origin = "http://localhost:5308";
    let launches = 0;
    const launcher: AgentLauncher = {
      launch: (profile, options) => {
        launches += 1;
        return acpLauncher().launch(profile, options);
      },
    };
    const before = agentLogEntries().length;
    const outcomes = await Promise.all([
      runTurn(
        claim(asId("thread", "t408a"), "fake-a", "hello"),
        harness(undefined, { appOrigin: origin, launcher }).deps,
      ),
      runTurn(
        claim(asId("thread", "t408b"), "fake-a", "hello"),
        harness(undefined, { appOrigin: origin, launcher }).deps,
      ),
    ]);
    expect(outcomes).toEqual([
      { state: "done", stopReason: "end_turn" },
      { state: "done", stopReason: "end_turn" },
    ]);
    expect(launches).toBe(1);
    const pids = new Set(
      agentLogEntries()
        .slice(before)
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => entry.pid),
    );
    expect(pids.size).toBe(1);

    await pool.drop(origin);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  }, 30_000);

  it("T4-11: a thread id two apps share never crosses from one app to the other", async () => {
    const [a, b] = await Promise.all([stubMcpApp(), stubMcpApp()]);
    const appProxy = createMcpProxy(BIN);
    await appProxy.listen(join(dir, "run", "apps.sock"));
    try {
      const thread = asId("thread", "t1");
      const turnOn = async (app: StubApp, token: string) => {
        const run = harness(undefined, { appOrigin: app.origin, proxy: appProxy });
        const before = agentLogEntries().length;
        expect(await runTurn(claim(thread, "fake-a", "probe", token), run.deps)).toEqual({
          state: "done",
          stopReason: "end_turn",
        });
        const prompt = agentLogEntries()
          .slice(before)
          .find((entry) => entry.method === "session/prompt")!;
        return { prompt, tokens: [token, ...run.issued].map((t) => `Bearer ${t}`) };
      };

      const first = await turnOn(a, "turn-a1");
      const other = await turnOn(b, "turn-b1");
      const again = await turnOn(a, "turn-a2");

      expect(other.prompt.pid).not.toBe(first.prompt.pid);
      expect(other.prompt.text!.startsWith(CONTEXT)).toBe(true);
      expect(again.prompt.pid).toBe(first.prompt.pid);
      expect(again.prompt.text!.startsWith(CONTEXT)).toBe(false);

      expect(a.bearers).toHaveLength(2);
      expect(b.bearers).toHaveLength(1);
      for (const bearer of a.bearers) {
        expect([...first.tokens, ...again.tokens]).toContain(bearer);
      }
      for (const bearer of b.bearers) expect(other.tokens).toContain(bearer);
    } finally {
      await pool.drop(a.origin);
      await pool.drop(b.origin);
      await appProxy.close();
      await Promise.all([a.close(), b.close()]);
    }
  }, 60_000);

  it("T4-09: an agent with no mode that asks never gets a remote prompt", async () => {
    const run = harness();
    const before = agentLogEntries().length;
    expect(
      await runTurn(claim(asId("thread", "t409"), "fake-bypass", "hello"), run.deps),
    ).toEqual({ state: "failed", reason: "agent_unavailable" });
    const received = agentLogEntries()
      .slice(before)
      .map((entry) => entry.method);
    expect(received).toContain("session/new");
    expect(received).not.toContain("session/prompt");
    expect(run.logged.at(-1)).toMatchObject({
      kind: "finish",
      outcome: { state: "failed", reason: "agent_unavailable" },
    });
    expect(run.appended().at(-1)).toMatchObject({
      kind: "event",
      body: { event: "turn_failed", detail: expect.stringContaining("Fake bypass") },
    });
  }, 30_000);
});
