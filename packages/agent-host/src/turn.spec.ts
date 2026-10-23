import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pairingProof } from "@parlor/auth";
import { deviceCode } from "@parlor/capabilities/encoding";
import type {
  ClaimedTurn,
  HostFrame,
  HostItemDraft,
  LoggedItem,
  TurnOutcome,
  TurnSignals,
} from "@parlor/chat";
import { asId, type ThreadId } from "@parlor/core";
import type { DeviceKeys } from "@parlor/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { acpLauncher, type AgentLauncher } from "./acp.js";
import type { AppGrant } from "./grants.js";
import type { AppLink } from "./link.js";
import { createMcpProxy, type McpProxy } from "./mcp-proxy.js";
import { computerName } from "./naming.js";
import { DEFAULT_POLICY, DEV_POLICY, type RemotePolicy } from "./policy.js";
import { createSessionPool, type SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import { memoryTrust, TestDevice } from "./spec-kit.js";
import { type FakeAgentScript, fakeAgentProfile } from "./testing/fake-agent.js";
import type { TrustedDevice, TrustStore } from "./trust.js";
import { PROMPT_MAX_AGE_MS, runTurn, type TurnDeps } from "./turn.js";

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

const codexLike: FakeAgentScript = {
  fallback: "echo",
  advertise: {
    modes: { current: "workspace-write", available: ["read-only", "workspace-write"] },
  },
  steps: {},
};

const bypassClosable: FakeAgentScript = {
  ...bypassOnly,
  advertise: { ...bypassOnly.advertise, close: true },
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
  await writeFile(join(dir, "codex.json"), JSON.stringify(codexLike));
  await writeFile(join(dir, "bypass-close.json"), JSON.stringify(bypassClosable));
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
  readonly modeId?: string;
  readonly at: number;
  readonly method: string;
  readonly pid: number;
  readonly sessionId?: string;
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
  readonly trust?: TrustStore;
  readonly policy?: RemotePolicy;
  readonly prompter?: Partial<LocalPrompter>;
  readonly now?: () => number;
  readonly pairing?: TurnDeps["pairing"];
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
  const now = options.now ?? (() => Date.now());
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
    approveDevice: async () => false,
    answerHere: async () => undefined,
    turnStarted: () => undefined,
    ...options.prompter,
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
        ...fakeAgentProfile(ENTRY, join(dir, "codex.json")),
        id: "fake-codex",
        name: "Fake Codex",
      },
      {
        ...fakeAgentProfile(ENTRY, join(dir, "bypass.json")),
        id: "fake-bypass",
        name: "Fake bypass",
      },
      {
        ...fakeAgentProfile(ENTRY, join(dir, "bypass-close.json")),
        id: "fake-bypass-close",
        name: "Fake bypass with close",
      },
    ],
    launcher: options.launcher ?? acpLauncher(),
    pool,
    proxy: options.proxy ?? proxy,
    trust: options.trust ?? memoryTrust(),
    policy: options.policy ?? DEV_POLICY,
    prompter,
    now,
    ...(options.pairing ? { pairing: options.pairing } : {}),
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

  const refusedTurns = async (origin: string, agentId: string) => {
    const received: AgentLogEntry[][] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = harness(undefined, { appOrigin: origin });
      const before = agentLogEntries().length;
      expect(
        await runTurn(claim(asId("thread", "t414"), agentId, "hello"), run.deps),
      ).toEqual({ state: "failed", reason: "agent_unavailable" });
      received.push(agentLogEntries().slice(before));
    }
    expect(received.flat().map((entry) => entry.method)).not.toContain("session/prompt");
    return received;
  };

  it("T4-14: a refused session the agent cannot close takes its process with it", async () => {
    const received = await refusedTurns("http://localhost:5314", "fake-bypass");
    const pids = received.map(
      (turn) => turn.find((entry) => entry.method === "session/new")!.pid,
    );
    expect(new Set(pids).size).toBe(3);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  }, 60_000);

  it("T4-14: a refused session the agent can close is closed before the turn ends", async () => {
    const received = await refusedTurns("http://localhost:5315", "fake-bypass-close");
    for (const turn of received) {
      const opened = turn.find((entry) => entry.method === "session/new")!;
      expect(turn.filter((entry) => entry.method === "session/close")).toEqual([
        expect.objectContaining({ pid: opened.pid, sessionId: expect.any(String) }),
      ]);
    }
    const closed = received.flat().filter((entry) => entry.method === "session/close");
    expect(new Set(closed.map((entry) => entry.sessionId)).size).toBe(3);
  }, 60_000);
});

const APP = grant.appOrigin;
const MINUTE = 60_000;
const WAIT = { timeout: 10_000 };

const pinOf = (device: TestDevice): TrustedDevice => ({
  deviceId: device.id,
  signingKey: device.keys.signingKey,
  presenceKey: device.keys.presenceKey,
  name: device.keys.name,
  platform: device.keys.platform,
  approvedAt: 1,
  via: "local",
});

async function signedClaim(
  device: TestDevice,
  thread: ThreadId,
  text: string,
  options: {
    readonly at?: number;
    readonly agent?: string;
    readonly app?: string;
    readonly device?: DeviceKeys | undefined;
    readonly sign?: boolean;
    readonly pairing?: string;
  } = {},
): Promise<ClaimedTurn> {
  const base = claim(thread, options.agent ?? "fake-a", text);
  const signed =
    options.sign === false
      ? undefined
      : await device.signPrompt(
          options.app ?? APP,
          { threadId: thread, turnId: base.turnId, agent: base.agent, text },
          options.at ?? Date.now(),
        );
  return {
    ...base,
    prompt: {
      ...base.prompt,
      body: {
        ...base.prompt.body,
        ...(signed
          ? {
              signed: {
                ...signed,
                ...(options.pairing ? { pairing: options.pairing } : {}),
              },
            }
          : {}),
      },
    },
    device: "device" in options ? options.device : device.keys,
  };
}

const ranAgentFor = (marker: string) =>
  prompts().some((entry) => entry.text?.includes(marker));

const finishOf = (run: ReturnType<typeof harness>) =>
  run.logged.find((entry) => entry.kind === "finish")?.outcome;

const eventsOf = (run: ReturnType<typeof harness>) =>
  run.appended().flatMap((item) => (item.kind === "event" ? [item.body] : []));

describe("runTurn trusting the device that sent the prompt", () => {
  const policy = DEFAULT_POLICY;

  it("T5-07a: a prompt queued longer than 10 minutes ends prompt_expired, never signature_invalid", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const signedAt = Date.now();
    const turn = await signedClaim(device, asId("thread", "t507a"), "queued-long", {
      at: signedAt,
    });
    const run = harness(undefined, { trust, policy, now: () => signedAt + 11 * MINUTE });
    expect(await runTurn(turn, run.deps)).toEqual({
      state: "failed",
      reason: "prompt_expired",
    });
    expect(finishOf(run)).toEqual({ state: "failed", reason: "prompt_expired" });
    expect(ranAgentFor("queued-long")).toBe(false);
  });

  it("runs a prompt just inside the window, and tells a forgery from a stale prompt", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const now = Date.now();
    const fresh = await signedClaim(
      device,
      asId("thread", "t507-fresh"),
      "fresh-prompt",
      {
        at: now - 9 * MINUTE,
      },
    );
    const run = harness(undefined, { trust, policy, now: () => now });
    expect(await runTurn(fresh, run.deps)).toMatchObject({ state: "done" });
    const forged = await signedClaim(
      device,
      asId("thread", "t507-forged"),
      "forged-prompt",
    );
    const tampered = {
      ...forged,
      prompt: {
        ...forged.prompt,
        body: { ...forged.prompt.body, text: "something else" },
      },
    };
    const other = harness(undefined, { trust, policy });
    expect(await runTurn(tampered, other.deps)).toEqual({
      state: "failed",
      reason: "signature_invalid",
    });
    expect(ranAgentFor("something else")).toBe(false);
  });

  it("lowers the window with PARLOR_HOST_PROMPT_MAX_AGE_MS and never raises it", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const at = Date.now();
    vi.stubEnv("PARLOR_HOST_PROMPT_MAX_AGE_MS", "1000");
    try {
      const lowered = harness(undefined, { trust, policy, now: () => at + 2_000 });
      const turn = await signedClaim(device, asId("thread", "t507-env"), "env-low", {
        at,
      });
      expect(await runTurn(turn, lowered.deps)).toEqual({
        state: "failed",
        reason: "prompt_expired",
      });
      vi.stubEnv("PARLOR_HOST_PROMPT_MAX_AGE_MS", String(PROMPT_MAX_AGE_MS * 10));
      const raised = harness(undefined, { trust, policy, now: () => at + 11 * MINUTE });
      const again = await signedClaim(device, asId("thread", "t507-env2"), "env-high", {
        at,
      });
      expect(await runTurn(again, raised.deps)).toEqual({
        state: "failed",
        reason: "prompt_expired",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("FAKE_AGENT_LOG", agentLog);
    }
  });

  it("holds a new device's first prompt for the dialog, starting no agent until it is pinned", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    let allow!: (answer: boolean) => void;
    const approveDevice = vi.fn(
      () => new Promise<boolean>((resolve) => (allow = resolve)),
    );
    const run = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const turn = await signedClaim(device, asId("thread", "t5-new"), "first-prompt");
    const running = runTurn(turn, run.deps);
    await vi.waitFor(() => expect(approveDevice).toHaveBeenCalledOnce());
    expect(approveDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "Hello",
        account: grant.account,
        device: { name: "Chrome on macOS", platform: "web" },
        code: await deviceCode(device.keys.signingKey),
      }),
    );
    await vi.waitFor(() => expect(eventsOf(run)).toEqual([{ event: "device_pending" }]));
    expect(ranAgentFor("first-prompt")).toBe(false);
    expect(await trust.get(APP, device.id)).toBeUndefined();
    allow(true);
    expect(await running).toMatchObject({ state: "done" });
    expect(ranAgentFor("first-prompt")).toBe(true);
    expect(await trust.get(APP, device.id)).toMatchObject({
      deviceId: device.id,
      name: "Chrome on macOS",
      platform: "web",
      via: "local",
      signingKey: device.keys.signingKey,
    });
  });

  it("fails a refused device with device_rejected, remembers nothing, and asks again next time", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    const approveDevice = vi.fn(async () => false);
    const run = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const turn = await signedClaim(device, asId("thread", "t5-no"), "refused-prompt");
    expect(await runTurn(turn, run.deps)).toEqual({
      state: "failed",
      reason: "device_rejected",
    });
    expect(eventsOf(run)).toEqual([
      { event: "device_pending" },
      { event: "device_rejected" },
    ]);
    expect(trust.pins()).toEqual([]);
    expect(ranAgentFor("refused-prompt")).toBe(false);
    const next = await signedClaim(device, asId("thread", "t5-no2"), "refused-again");
    await runTurn(
      next,
      harness(undefined, { trust, policy, prompter: { approveDevice } }).deps,
    );
    expect(approveDevice).toHaveBeenCalledTimes(2);
  });

  it("trusts the browser that approved connect, unasked, once its first prompt proves the pairing secret", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    const secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I";
    let held: string | undefined = secret;
    const forget = vi.fn(async () => {
      held = undefined;
    });
    const approveDevice = vi.fn(async () => false);
    const run = harness(undefined, {
      trust,
      policy,
      prompter: { approveDevice },
      pairing: { secret: async () => held, forget },
    });
    const turn = await signedClaim(device, asId("thread", "t5-paired"), "paired-prompt", {
      pairing: await pairingProof(secret, device.id, device.keys.signingKey),
    });
    expect(await runTurn(turn, run.deps)).toMatchObject({ state: "done" });
    expect(approveDevice).not.toHaveBeenCalled();
    expect(eventsOf(run)).toEqual([]);
    expect(forget).toHaveBeenCalledOnce();
    expect(await trust.get(APP, device.id)).toMatchObject({
      deviceId: device.id,
      via: "pairing",
      signingKey: device.keys.signingKey,
    });
  });

  it("asks as for any new device when the pairing proof is for another device or secret", async () => {
    const device = await TestDevice.create();
    const other = await TestDevice.create();
    const secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I";
    const forget = vi.fn(async () => undefined);
    for (const pairing of [
      await pairingProof(secret, other.id, other.keys.signingKey),
      await pairingProof(
        "b3RoZXItb3RoZXItb3RoZXItb3RoZXItb3RoZXItb3R",
        device.id,
        device.keys.signingKey,
      ),
    ]) {
      const approveDevice = vi.fn(async () => false);
      const run = harness(undefined, {
        trust: memoryTrust(),
        policy,
        prompter: { approveDevice },
        pairing: { secret: async () => secret, forget },
      });
      const turn = await signedClaim(device, asId("thread", "t5-forged"), "forged", {
        pairing,
      });
      expect(await runTurn(turn, run.deps)).toEqual({
        state: "failed",
        reason: "device_rejected",
      });
      expect(approveDevice).toHaveBeenCalledOnce();
    }
    expect(forget).not.toHaveBeenCalled();
  });

  it("does not ask again for a pinned device, and runs its prompt", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const approveDevice = vi.fn(async () => false);
    const run = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const turn = await signedClaim(device, asId("thread", "t5-pinned"), "pinned-prompt");
    expect(await runTurn(turn, run.deps)).toMatchObject({ state: "done" });
    expect(approveDevice).not.toHaveBeenCalled();
    expect(eventsOf(run)).toEqual([]);
  });

  it("refuses a pinned device whose keys the backend now reports differently, with no dialog", async () => {
    const device = await TestDevice.create();
    const attacker = await TestDevice.create(device.id);
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const approveDevice = vi.fn(async () => true);
    const run = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const turn = await signedClaim(attacker, asId("thread", "t5-swap"), "swapped-prompt");
    expect(await runTurn(turn, run.deps)).toEqual({
      state: "failed",
      reason: "signature_invalid",
    });
    expect(approveDevice).not.toHaveBeenCalled();
    expect(ranAgentFor("swapped-prompt")).toBe(false);
    expect((await trust.get(APP, device.id))?.signingKey).toEqual(device.keys.signingKey);
  });

  it("R5-03: refuses a pinned device the account no longer lists with no dialog, and drops its pin", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const approveDevice = vi.fn(async () => true);
    const run = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const turn = await signedClaim(device, asId("thread", "t5-gone"), "revoked-prompt", {
      device: undefined,
    });
    expect(await runTurn(turn, run.deps)).toEqual({
      state: "failed",
      reason: "device_rejected",
    });
    expect(approveDevice).not.toHaveBeenCalled();
    expect(ranAgentFor("revoked-prompt")).toBe(false);
    expect(await trust.get(APP, device.id)).toBeUndefined();
  });

  it("T6-08: tells the user to update when a prompt arrives unsigned, as an older client sends it", async () => {
    const device = await TestDevice.create();
    const approveDevice = vi.fn(async () => true);
    const run = harness(undefined, { policy, prompter: { approveDevice } });
    const before = prompts().length;
    const unsigned = await signedClaim(
      device,
      asId("thread", "t608-unsigned"),
      "unsigned-one",
      { sign: false },
    );
    expect(await runTurn(unsigned, run.deps)).toEqual({
      state: "failed",
      reason: "device_rejected",
    });
    expect(finishOf(run)).toEqual({ state: "failed", reason: "device_rejected" });
    expect(eventsOf(run)).toEqual([
      {
        event: "turn_failed",
        detail: `Update Hello to send messages to ${computerName()}: this version does not sign them.`,
      },
    ]);
    expect(prompts()).toHaveLength(before);
    expect(ranAgentFor("unsigned-one")).toBe(false);
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("refuses a prompt from a device the account does not know", async () => {
    const device = await TestDevice.create();
    const approveDevice = vi.fn(async () => true);
    const run = harness(undefined, { policy, prompter: { approveDevice } });
    const unknown = await signedClaim(
      device,
      asId("thread", "t5-unknown"),
      "unknown-one",
      {
        device: undefined,
      },
    );
    expect(await runTurn(unknown, run.deps)).toEqual({
      state: "failed",
      reason: "signature_invalid",
    });
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("refuses a prompt signed for another app's origin, however the backend relays it", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const run = harness(undefined, { trust, policy });
    const turn = await signedClaim(
      device,
      asId("thread", "t5-origin"),
      "other-app-prompt",
      {
        app: "https://evil.example",
      },
    );
    expect(await runTurn(turn, run.deps)).toEqual({
      state: "failed",
      reason: "signature_invalid",
    });
    expect(ranAgentFor("other-app-prompt")).toBe(false);
  });

  it("refuses a new device's forged or stale prompt without showing a dialog", async () => {
    const device = await TestDevice.create();
    const stranger = await TestDevice.create();
    const approveDevice = vi.fn(async () => true);
    const run = harness(undefined, { policy, prompter: { approveDevice } });
    const forged = await signedClaim(stranger, asId("thread", "t5-forge"), "forged-new", {
      device: device.keys,
    });
    expect(await runTurn(forged, run.deps)).toMatchObject({
      reason: "signature_invalid",
    });
    const stale = await signedClaim(device, asId("thread", "t5-stale"), "stale-new", {
      at: Date.now() - 20 * MINUTE,
    });
    expect(await runTurn(stale, run.deps)).toMatchObject({ reason: "prompt_expired" });
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("closes the dialog and ends the turn cancelled when the user stops it meanwhile", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    let dialog: AbortSignal | undefined;
    const approveDevice = vi.fn(
      ({ signal }: { signal?: AbortSignal | undefined }) =>
        new Promise<boolean>((resolve) => {
          dialog = signal;
          signal?.addEventListener("abort", () => resolve(false));
        }),
    );
    let cancelled = false;
    const run = harness(
      (afterSeq) =>
        cancelled
          ? [
              {
                turnId: asId("turn", `u${turns}`),
                items: [
                  {
                    id: asId("item", "c1"),
                    threadId: asId("thread", "t5-cancel"),
                    turnId: asId("turn", `u${turns}`),
                    seq: afterSeq + 1,
                    at: Date.now(),
                    author: "user",
                    kind: "cancel",
                    body: {},
                  },
                ],
              },
            ]
          : [],
      { trust, policy, prompter: { approveDevice } },
    );
    const turn = await signedClaim(device, asId("thread", "t5-cancel"), "cancelled-new");
    const running = runTurn(turn, run.deps);
    await vi.waitFor(() => expect(approveDevice).toHaveBeenCalled());
    cancelled = true;
    expect(await running).toEqual({ state: "cancelled" });
    await vi.waitFor(() => expect(dialog?.aborted).toBe(true));
    expect(trust.pins()).toEqual([]);
    expect(ranAgentFor("cancelled-new")).toBe(false);
  });

  it("shows one dialog for two prompts from the same new device at once", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    let allow!: (answer: boolean) => void;
    const approveDevice = vi.fn(
      () => new Promise<boolean>((resolve) => (allow = resolve)),
    );
    const first = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const second = harness(undefined, { trust, policy, prompter: { approveDevice } });
    const a = runTurn(
      await signedClaim(device, asId("thread", "t5-two-a"), "two-a"),
      first.deps,
    );
    const b = runTurn(
      await signedClaim(device, asId("thread", "t5-two-b"), "two-b"),
      second.deps,
    );
    await vi.waitFor(() => expect(approveDevice).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    allow(true);
    expect(await Promise.all([a, b])).toEqual([
      { state: "done", stopReason: "end_turn" },
      { state: "done", stopReason: "end_turn" },
    ]);
    expect(approveDevice).toHaveBeenCalledOnce();
    expect(eventsOf(first)).toEqual([{ event: "device_pending" }]);
    expect(eventsOf(second)).toEqual([{ event: "device_pending" }]);
  });

  it("skips every device check when the policy turns approval off", async () => {
    const device = await TestDevice.create();
    const run = harness(undefined, { policy: DEV_POLICY });
    const turn = await signedClaim(device, asId("thread", "t5-off"), "unchecked", {
      sign: false,
      device: undefined,
    });
    expect(await runTurn(turn, run.deps)).toMatchObject({ state: "done" });
  });
});

describe("runTurn taking answers only as the policy says", () => {
  const askThread = asId("thread", "t5-ask");

  function chatAnswers(
    run: () => ReturnType<typeof harness>,
    bodies: () => readonly Record<string, unknown>[] | undefined,
    devices: readonly DeviceKeys[] = [],
  ) {
    let sent = 0;
    return (afterSeq: number): TurnSignals[] => {
      const ask = run()
        .appended()
        .find((item) => item.kind === "ask");
      const queued = bodies();
      if (!ask || !queued || sent >= queued.length) return [];
      const turnId = asId("turn", `u${turns}`);
      sent += 1;
      return [
        {
          turnId,
          items: [
            {
              id: asId("item", `a${sent}`),
              threadId: askThread,
              turnId,
              seq: afterSeq + 1,
              at: Date.now(),
              author: "user",
              kind: "answer",
              body: { askId: ask.id, choice: "allow", ...queued[sent - 1] },
            } as LoggedItem<"answer">,
          ],
          ...(devices.length > 0 ? { devices } : {}),
        },
      ];
    };
  }

  const askOf = (run: ReturnType<typeof harness>) =>
    run.appended().find((item) => item.kind === "ask");

  it("keeps a presence ask open until an answer carries a presence signature", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    let answers: Record<string, unknown>[] | undefined;
    const run: ReturnType<typeof harness> = harness(
      chatAnswers(
        () => run,
        () => answers,
      ),
      { trust, policy: DEFAULT_POLICY },
    );
    const running = runTurn(await signedClaim(device, askThread, "scripted"), run.deps);
    await vi.waitFor(() => expect(askOf(run)).toBeDefined());
    expect(askOf(run)!.body).toMatchObject({ approval: "presence" });
    const answer = { threadId: askThread, askId: askOf(run)!.id, choice: "allow" };
    const at = Date.now();
    answers = [
      {},
      { signed: await device.signAnswer(APP, answer, at, false) },
      { signed: await device.signAnswer(APP, answer, at, true) },
    ];
    expect(await running).toMatchObject({ state: "done" });
    expect(eventsOf(run).filter((body) => body.event === "answer_rejected")).toEqual([
      expect.objectContaining({ itemId: "a1" }),
      expect.objectContaining({ itemId: "a2" }),
    ]);
    expect(run.appended().find((item) => item.kind === "tool")!.body).toMatchObject({
      status: "done",
    });
  }, 30_000);

  it("refuses an answer signed for another ask, another app or by a device this computer never pinned", async () => {
    const device = await TestDevice.create();
    const stranger = await TestDevice.create("device-2");
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    let answers: Record<string, unknown>[] | undefined;
    const run: ReturnType<typeof harness> = harness(
      chatAnswers(
        () => run,
        () => answers,
      ),
      { trust, policy: DEFAULT_POLICY },
    );
    const running = runTurn(await signedClaim(device, askThread, "scripted"), run.deps);
    await vi.waitFor(() => expect(askOf(run)).toBeDefined());
    const answer = { threadId: askThread, askId: askOf(run)!.id, choice: "allow" };
    const at = Date.now();
    answers = [
      { signed: await device.signAnswer(APP, { ...answer, choice: "reject" }, at, true) },
      { signed: await device.signAnswer("https://evil.example", answer, at, true) },
      { signed: await stranger.signAnswer(APP, answer, at, true) },
      { signed: await device.signAnswer(APP, answer, at, true) },
    ];
    expect(await running).toMatchObject({ state: "done" });
    expect(
      eventsOf(run)
        .filter((body) => body.event === "answer_rejected")
        .map((body) => body.itemId),
    ).toEqual(["a1", "a2", "a3"]);
  }, 30_000);

  it("answers only on this computer when the policy says so", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    const answerHere = vi.fn(async () => "allow");
    const run = harness(undefined, {
      trust,
      policy: { deviceApproval: "local", answers: "computer" },
      prompter: { answerHere },
    });
    const running = runTurn(await signedClaim(device, askThread, "scripted"), run.deps);
    await vi.waitFor(() => expect(askOf(run)).toBeDefined());
    expect(askOf(run)!.body).toMatchObject({ approval: "computer" });
    await vi.waitFor(() => expect(answerHere).toHaveBeenCalled());
    expect(answerHere).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "Hello",
        question: "date",
        choices: [
          { id: "allow", label: "Allow", effect: "allow_once" },
          { id: "reject", label: "Reject", effect: "reject_once" },
        ],
      }),
    );
    expect(await running).toMatchObject({ state: "done" });
    expect(eventsOf(run)).toContainEqual({
      event: "answered_on_computer",
      itemId: askOf(run)!.id,
      choice: "allow",
    });
  }, 30_000);

  it("R5-06: closes the dialog of a question answered on the computer when the turn is cancelled", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    let dialog: AbortSignal | undefined;
    const answerHere = vi.fn(
      ({ signal }: { signal?: AbortSignal | undefined }) =>
        new Promise<string | undefined>((resolve) => {
          dialog = signal;
          signal?.addEventListener("abort", () => resolve(undefined));
        }),
    );
    let cancelled = false;
    const run: ReturnType<typeof harness> = harness(
      (afterSeq) => {
        if (!cancelled) return [];
        const turnId = asId("turn", `u${turns}`);
        return [
          {
            turnId,
            items: [
              {
                id: asId("item", "c1"),
                threadId: askThread,
                turnId,
                seq: afterSeq + 1,
                at: Date.now(),
                author: "user",
                kind: "cancel",
                body: {},
              },
            ],
          },
        ];
      },
      {
        trust,
        policy: { deviceApproval: "local", answers: "computer" },
        prompter: { answerHere },
      },
    );
    const running = runTurn(await signedClaim(device, askThread, "scripted"), run.deps);
    await vi.waitFor(() => expect(answerHere).toHaveBeenCalled());
    expect(dialog?.aborted).toBe(false);
    cancelled = true;
    expect(await running).toEqual({ state: "cancelled" });
    expect(dialog?.aborted).toBe(true);
  }, 30_000);

  it("refuses a chat answer to a question that is answered on the computer", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, pinOf(device));
    let release!: (choice: string) => void;
    const answerHere = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    let answers: Record<string, unknown>[] | undefined;
    const run: ReturnType<typeof harness> = harness(
      chatAnswers(
        () => run,
        () => answers,
      ),
      {
        trust,
        policy: { deviceApproval: "local", answers: "computer" },
        prompter: { answerHere },
      },
    );
    const running = runTurn(await signedClaim(device, askThread, "scripted"), run.deps);
    await vi.waitFor(() => expect(askOf(run)).toBeDefined());
    const answer = { threadId: askThread, askId: askOf(run)!.id, choice: "allow" };
    answers = [{ signed: await device.signAnswer(APP, answer, Date.now(), true) }];
    await vi.waitFor(() =>
      expect(eventsOf(run).some((body) => body.event === "answer_rejected")).toBe(true),
    );
    expect(run.appended().some((item) => item.kind === "tool")).toBe(false);
    release("allow");
    expect(await running).toMatchObject({ state: "done" });
  }, 30_000);

  it.each([
    ["presence", DEFAULT_POLICY, ["read-only"]],
    [
      "computer",
      { deviceApproval: "local", answers: "computer" } as const,
      ["read-only"],
    ],
    ["off", { deviceApproval: "local", answers: "off" } as const, []],
  ])(
    "pins the asking mode the policy needs for an agent that starts in workspace-write: answers %s",
    async (name, policy, expected) => {
      const device = await TestDevice.create();
      const trust = memoryTrust();
      await trust.pin(APP, pinOf(device));
      const thread = asId("thread", `t5-mode-${name}`);
      const before = agentLogEntries().length;
      const run = harness(undefined, { trust, policy });
      expect(
        await runTurn(
          await signedClaim(device, thread, "hello", { agent: "fake-codex" }),
          run.deps,
        ),
      ).toMatchObject({ state: "done" });
      expect(
        agentLogEntries()
          .slice(before)
          .filter((entry) => entry.method === "session/set_mode")
          .map((entry) => entry.modeId),
      ).toEqual(expected);
    },
    30_000,
  );

  it("asks on the computer when the device has no presence key to answer with", async () => {
    const device = await TestDevice.create();
    const trust = memoryTrust();
    await trust.pin(APP, { ...pinOf(device), presenceKey: undefined });
    const answerHere = vi.fn(async () => "allow");
    const run = harness(undefined, {
      trust,
      policy: DEFAULT_POLICY,
      prompter: { answerHere },
    });
    const turn = await signedClaim(device, askThread, "scripted", {
      device: { ...device.keys, presenceKey: undefined },
    });
    expect(await runTurn(turn, run.deps)).toMatchObject({ state: "done" });
    expect(askOf(run)!.body).toMatchObject({ approval: "computer" });
    expect(answerHere).toHaveBeenCalledOnce();
  }, 30_000);
  const presenceAsk = async (
    run: () => ReturnType<typeof harness>,
    answers: () => Record<string, unknown>[] | undefined,
    pinned: TestDevice,
    devices: readonly DeviceKeys[] = [],
    options: {
      readonly prompter?: Partial<LocalPrompter>;
      readonly trust?: TrustStore;
    } = {},
  ) => {
    const trust = options.trust ?? memoryTrust();
    await trust.pin(APP, pinOf(pinned));
    const started: ReturnType<typeof harness> = harness(
      chatAnswers(run, answers, devices),
      { trust, policy: DEFAULT_POLICY, prompter: options.prompter ?? {} },
    );
    return { trust, started };
  };

  const asked = (run: ReturnType<typeof harness>) => askOf(run)!.id;
  const rejections = (run: ReturnType<typeof harness>) =>
    eventsOf(run)
      .filter((body) => body.event === "answer_rejected")
      .map((body) => body.itemId);
  const toolDone = (run: ReturnType<typeof harness>) =>
    run.appended().some((item) => item.kind === "tool");

  describe("T6-06: a device that never prompted answers after the computer approves it", () => {
    it("T6-06: Allow pins the phone by its name and platform, then hands its answer to the agent", async () => {
      const tab = await TestDevice.create();
      const phone = await TestDevice.create("device-2", "iPhone", "capacitor");
      let answers: Record<string, unknown>[] | undefined;
      let allow!: (answer: boolean) => void;
      const approveDevice = vi.fn(
        () => new Promise<boolean>((resolve) => (allow = resolve)),
      );
      const trust = memoryTrust();
      await trust.pin(APP, pinOf(tab));
      const run: ReturnType<typeof harness> = harness(
        chatAnswers(
          () => run,
          () => answers,
          [phone.keys],
        ),
        { trust, policy: DEFAULT_POLICY, prompter: { approveDevice } },
      );
      const running = runTurn(await signedClaim(tab, askThread, "scripted"), run.deps);
      await vi.waitFor(() => expect(askOf(run)).toBeDefined(), WAIT);
      answers = [
        {
          signed: await phone.signAnswer(
            APP,
            { threadId: askThread, askId: asked(run), choice: "allow" },
            Date.now(),
            true,
          ),
        },
      ];
      await vi.waitFor(() => expect(approveDevice).toHaveBeenCalledOnce(), WAIT);
      expect(approveDevice).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: "Hello",
          account: grant.account,
          device: { name: "iPhone", platform: "capacitor" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(toolDone(run)).toBe(false);
      expect(rejections(run)).toEqual([]);
      expect(await trust.get(APP, phone.id)).toBeUndefined();
      allow(true);
      expect(await running).toMatchObject({ state: "done" });
      expect(run.appended().find((item) => item.kind === "tool")!.body).toMatchObject({
        status: "done",
      });
      expect(rejections(run)).toEqual([]);
      expect(await trust.get(APP, phone.id)).toMatchObject({
        deviceId: phone.id,
        name: "iPhone",
        platform: "capacitor",
        via: "local",
        signingKey: phone.keys.signingKey,
        presenceKey: phone.keys.presenceKey,
      });
    }, 30_000);

    it("T6-06: Don't allow rejects the answer, leaves the phone unpinned and the ask open", async () => {
      const tab = await TestDevice.create();
      const phone = await TestDevice.create("device-2", "iPhone", "capacitor");
      let answers: Record<string, unknown>[] | undefined;
      let deny!: (answer: boolean) => void;
      const approveDevice = vi.fn(
        () => new Promise<boolean>((resolve) => (deny = resolve)),
      );
      const trust = memoryTrust();
      await trust.pin(APP, pinOf(tab));
      const run: ReturnType<typeof harness> = harness(
        chatAnswers(
          () => run,
          () => answers,
          [phone.keys],
        ),
        { trust, policy: DEFAULT_POLICY, prompter: { approveDevice } },
      );
      const running = runTurn(await signedClaim(tab, askThread, "scripted"), run.deps);
      await vi.waitFor(() => expect(askOf(run)).toBeDefined(), WAIT);
      const answer = { threadId: askThread, askId: asked(run), choice: "allow" };
      answers = [{ signed: await phone.signAnswer(APP, answer, Date.now(), true) }];
      await vi.waitFor(() => expect(approveDevice).toHaveBeenCalledOnce(), WAIT);
      expect(toolDone(run)).toBe(false);
      deny(false);
      await vi.waitFor(() => expect(rejections(run)).toEqual(["a1"]), WAIT);
      expect(toolDone(run)).toBe(false);
      expect(trust.pins().map((pin) => pin.deviceId)).toEqual([tab.id]);
      answers = [
        answers[0]!,
        { signed: await tab.signAnswer(APP, answer, Date.now(), true) },
      ];
      expect(await running).toMatchObject({ state: "done" });
      expect(rejections(run)).toEqual(["a1"]);
    }, 30_000);

    it("T6-06: keeps reading signals, so a stop request ends the turn while the dialog is open", async () => {
      const tab = await TestDevice.create();
      const phone = await TestDevice.create("device-2", "iPhone", "capacitor");
      let answers: Record<string, unknown>[] | undefined;
      let dialog: AbortSignal | undefined;
      const approveDevice = vi.fn(
        ({ signal }: { signal?: AbortSignal | undefined }) =>
          new Promise<boolean>((resolve) => {
            dialog = signal;
            signal?.addEventListener("abort", () => resolve(false));
          }),
      );
      let cancelled = false;
      const trust = memoryTrust();
      await trust.pin(APP, pinOf(tab));
      const answering = chatAnswers(
        () => run,
        () => answers,
        [phone.keys],
      );
      const run: ReturnType<typeof harness> = harness(
        (afterSeq) => {
          const batches = answering(afterSeq);
          if (!cancelled) return batches;
          const turnId = asId("turn", `u${turns}`);
          return [
            ...batches,
            {
              turnId,
              items: [
                {
                  id: asId("item", "c1"),
                  threadId: askThread,
                  turnId,
                  seq: afterSeq + 2,
                  at: Date.now(),
                  author: "user",
                  kind: "cancel",
                  body: {},
                },
              ],
            },
          ];
        },
        { trust, policy: DEFAULT_POLICY, prompter: { approveDevice } },
      );
      const running = runTurn(await signedClaim(tab, askThread, "scripted"), run.deps);
      await vi.waitFor(() => expect(askOf(run)).toBeDefined(), WAIT);
      answers = [
        {
          signed: await phone.signAnswer(
            APP,
            { threadId: askThread, askId: asked(run), choice: "allow" },
            Date.now(),
            true,
          ),
        },
      ];
      await vi.waitFor(() => expect(approveDevice).toHaveBeenCalledOnce(), WAIT);
      cancelled = true;
      expect(await running).toEqual({ state: "cancelled" });
      await vi.waitFor(() => expect(dialog?.aborted).toBe(true), WAIT);
      expect(trust.pins().map((pin) => pin.deviceId)).toEqual([tab.id]);
    }, 30_000);

    it("T6-06: rejects the answer of an unpinned device the signals carry no keys for", async () => {
      const tab = await TestDevice.create();
      const phone = await TestDevice.create("device-2", "iPhone", "capacitor");
      let answers: Record<string, unknown>[] | undefined;
      const approveDevice = vi.fn(async () => true);
      const { trust, started: run } = await presenceAsk(
        () => run,
        () => answers,
        tab,
        [],
        { prompter: { approveDevice } },
      );
      const running = runTurn(await signedClaim(tab, askThread, "scripted"), run.deps);
      await vi.waitFor(() => expect(askOf(run)).toBeDefined(), WAIT);
      const answer = { threadId: askThread, askId: asked(run), choice: "allow" };
      answers = [{ signed: await phone.signAnswer(APP, answer, Date.now(), true) }];
      await vi.waitFor(() => expect(rejections(run)).toEqual(["a1"]), WAIT);
      answers = [
        answers[0]!,
        { signed: await tab.signAnswer(APP, answer, Date.now(), true) },
      ];
      expect(await running).toMatchObject({ state: "done" });
      expect(approveDevice).not.toHaveBeenCalled();
      expect(trust.pins().map((pin) => pin.deviceId)).toEqual([tab.id]);
    }, 30_000);
  });

  it("T6-09: a mislabeled, wrong-app or key-swapped answer never reaches the agent, and an extra field does no harm", async () => {
    const tab = await TestDevice.create();
    const phone = await TestDevice.create("device-2", "iPhone", "capacitor");
    const impostor = await TestDevice.create("device-2", "iPhone", "capacitor");
    const logFile = join(dir, "t609.log");
    const { openHostLog } = await import("./log.js");
    openHostLog(logFile);
    let answers: Record<string, unknown>[] | undefined;
    const approveDevice = vi.fn(async () => true);
    const { trust, started: run } = await presenceAsk(
      () => run,
      () => answers,
      tab,
      [impostor.keys],
      { prompter: { approveDevice } },
    );
    const running = runTurn(await signedClaim(tab, askThread, "scripted"), run.deps);
    await vi.waitFor(() => expect(askOf(run)).toBeDefined(), WAIT);
    const answer = { threadId: askThread, askId: asked(run), choice: "allow" };
    const at = Date.now();
    const relabeled = await tab.signAnswer(APP, answer, at, false);
    const forged = await phone.signAnswer(APP, answer, at, true);
    const withExtras = await tab.signAnswer(APP, answer, at, true);
    answers = [
      {
        signed: {
          ...relabeled,
          signature: { ...relabeled.signature, presence: "user" },
        },
      },
      { signed: await tab.signAnswer("https://evil.example", answer, at, true) },
      { signed: forged },
    ];
    await vi.waitFor(() => expect(rejections(run)).toEqual(["a1", "a2", "a3"]), WAIT);
    expect(toolDone(run)).toBe(false);
    expect(approveDevice).not.toHaveBeenCalled();
    expect(trust.pins().map((pin) => pin.deviceId)).toEqual([tab.id]);
    const verified = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === "statement_verified" && entry.kind === "answer");
    expect(verified).toContainEqual(
      expect.objectContaining({
        deviceId: phone.id,
        outcome: "invalid",
        sha256: expect.any(String),
      }),
    );
    answers = [
      ...answers,
      {
        signed: {
          ...withExtras,
          unknown: "field",
          signature: { ...withExtras.signature, unknown: "field" },
        },
      },
    ];
    expect(await running).toMatchObject({ state: "done" });
    expect(rejections(run)).toEqual(["a1", "a2", "a3"]);
    expect(toolDone(run)).toBe(true);
  }, 30_000);
});
