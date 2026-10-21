import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaimedTurn, HostItemDraft, TurnOutcome } from "@parlor/chat";
import { asId, type ThreadId } from "@parlor/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  AgentConnection,
  AgentLauncher,
  AgentSession,
  StopReason,
  TurnHandlers,
} from "./acp.js";
import type { AppGrant } from "./grants.js";
import type { AppLink } from "./link.js";
import { openHostLog } from "./log.js";
import type { McpProxy, ProxySession } from "./mcp-proxy.js";
import { DEV_POLICY } from "./policy.js";
import { createSessionPool, type SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import { agentEnvironment } from "./shell-path.js";
import { memoryTrust } from "./spec-kit.js";
import { fakeAgentProfile } from "./testing/fake-agent.js";
import { runTurn, type TurnDeps } from "./turn.js";

const LEASE_MS = 60_000;
const SECOND = 1000;

let dir: string;
let pool: SessionPool;

const grant: AppGrant = {
  appOrigin: "http://localhost:5311",
  appName: "Hello",
  grantId: asId("grant", "host:g1"),
  hostId: asId("host", "h1"),
  account: { userId: asId("user", "alice"), name: "Alice", email: "alice@example.com" },
  workspace: "",
  createdAt: 1,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-turn-lost-"));
  await agentEnvironment();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  pool = createSessionPool(join(dir, "sessions.json"));
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await pool.drop(grant.appOrigin);
});

const realTick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(condition: () => boolean) {
  for (let spins = 0; spins < 400 && !condition(); spins += 1) {
    await realTick();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(condition()).toBe(true);
}

class FakeSession implements AgentSession {
  readonly resumed = false;
  prompts = 0;
  cancels = 0;
  handlers: TurnHandlers | undefined;
  #finish: ((stop: StopReason) => void) | undefined;

  constructor(readonly id: string) {}

  prompt(_blocks: unknown, handlers: TurnHandlers): Promise<StopReason> {
    this.prompts += 1;
    this.handlers = handlers;
    return new Promise((resolve) => (this.#finish = resolve));
  }

  cancel = async () => {
    this.cancels += 1;
    this.#finish?.("cancelled");
  };

  close = async () => undefined;

  say(thought: string) {
    this.handlers!.update({ kind: "thought", text: thought });
    this.handlers!.update({ kind: "text", text: "..." });
  }

  end(stop: StopReason = "end_turn") {
    this.#finish?.(stop);
  }
}

function fakeAgent() {
  const sessions: FakeSession[] = [];
  let kills = 0;
  const connection: AgentConnection = {
    capabilities: { resume: false, close: false, mcpHttp: true, ready: true },
    exited: new Promise(() => undefined),
    kill: async () => void (kills += 1),
    openSession: async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return session;
    },
  };
  const launcher: AgentLauncher = { launch: async () => connection };
  return { launcher, sessions, kills: () => kills };
}

function fakeProxy() {
  const sessions: { begun: number; ended: number }[] = [];
  const proxy: McpProxy = {
    listen: async () => undefined,
    stopListening: async () => undefined,
    close: async () => undefined,
    open: () => {
      const counts = { begun: 0, ended: 0 };
      sessions.push(counts);
      return {
        nonce: "n",
        server: { name: "hello", command: "x", args: [], env: {} },
        begin: () => void (counts.begun += 1),
        renew: () => undefined,
        end: () => void (counts.ended += 1),
        dispose: () => undefined,
      } satisfies ProxySession;
    },
  };
  return { proxy, sessions };
}

type AppendMode = "ok" | "fail" | "hang";

function fakeLink() {
  const link = { mode: "ok" as AppendMode };
  const appendAt: number[] = [];
  const appended: string[] = [];
  const finished: TurnOutcome[] = [];
  let signals = 0;
  const stub = {
    grant: { ...grant, workspace: dir },
    protocol: 1,
    api: {
      calls: {
        call: async (name: string, input: Record<string, unknown>) => {
          switch (name) {
            case "hostAppend":
              appendAt.push(Date.now());
              if (link.mode === "hang") return new Promise<never>(() => undefined);
              if (link.mode === "fail") throw new Error("offline");
              appended.push(...(input.items as HostItemDraft[]).map((item) => item.id));
              return {
                id: "t1",
                leaseUntil: Date.now() + LEASE_MS,
                token: { token: "t", expiresAt: Date.now() + LEASE_MS },
              };
            case "hostFinish":
              finished.push(input.outcome as TurnOutcome);
              return { id: "t1" };
            case "hostSignals":
              signals += 1;
              return [];
            default:
              throw new Error(`unexpected ${name}`);
          }
        },
      },
      stream: () => undefined,
      heartbeat: async () => undefined,
    },
  } as unknown as AppLink;
  return {
    link: stub,
    setMode: (mode: AppendMode) => void (link.mode = mode),
    appendAt,
    appended,
    finished,
    signals: () => signals,
  };
}

let claims = 0;
function claim(threadId: string): ClaimedTurn {
  claims += 1;
  const id = asId("thread", threadId) as ThreadId;
  const turnId = asId("turn", `u${claims}`);
  return {
    id,
    turnId,
    agent: { hostId: asId("host", "h1"), agentId: "fake-a" },
    clientId: "tab",
    prompt: {
      id: asId("item", `p${claims}`),
      threadId: id,
      turnId,
      seq: claims * 10,
      at: Date.now(),
      author: "user",
      kind: "prompt",
      body: { text: "go", agent: { hostId: asId("host", "h1"), agentId: "fake-a" } },
    },
    device: undefined,
    context: "",
    token: { token: `token-${claims}`, expiresAt: Date.now() + LEASE_MS },
    leaseUntil: Date.now() + LEASE_MS,
  };
}

function deps(
  link: AppLink,
  agent: ReturnType<typeof fakeAgent>,
  proxy: McpProxy,
): TurnDeps {
  const prompter: LocalPrompter = {
    confirmPairing: async () => false,
    approveDevice: async () => false,
    answerHere: async () => undefined,
    turnStarted: () => undefined,
  };
  return {
    link,
    profiles: [{ ...fakeAgentProfile("entry", "script"), id: "fake-a", name: "Fake A" }],
    launcher: agent.launcher,
    pool,
    proxy,
    trust: memoryTrust(),
    policy: DEV_POLICY,
    prompter,
    now: Date.now,
  };
}

async function started(
  threadId: string,
  agent: ReturnType<typeof fakeAgent>,
  proxy: McpProxy,
  link = fakeLink(),
) {
  const before = agent.sessions.filter((session) => session.prompts > 0).length;
  const outcome = runTurn(claim(threadId), deps(link.link, agent, proxy));
  const settled = outcome.then((value) => ({ value }));
  await until(
    () => agent.sessions.filter((session) => session.prompts > 0).length > before,
  );
  const session = agent.sessions.filter((candidate) => candidate.prompts > 0)[before]!;
  return { outcome, settled, session, link };
}

describe("a turn whose appends keep failing", () => {
  it.each(["fail", "hang"] as const)(
    "T7-04 (a) retries a %s-ing append until the lease would lapse, then ends the turn locally and leaves other threads alone",
    async (mode) => {
      const agent = fakeAgent();
      const { proxy, sessions } = fakeProxy();
      const a = await started("thread-a", agent, proxy);
      const b = await started("thread-b", agent, proxy);
      expect(agent.sessions).toHaveLength(2);

      const callAt = Date.now();
      a.link.setMode(mode);
      a.session.say("thinking");
      await vi.advanceTimersByTimeAsync(0);
      expect(a.link.appendAt).toEqual([callAt]);

      let ended: TurnOutcome | undefined;
      void a.outcome.then((value) => (ended = value));
      await vi.advanceTimersByTimeAsync(LEASE_MS - SECOND);
      expect(ended).toBeUndefined();
      if (mode === "fail") {
        expect(a.link.appendAt.length).toBeGreaterThan(5);
        const gaps = a.link.appendAt.slice(1).map((at, i) => at - a.link.appendAt[i]!);
        expect(gaps.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 4000]);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(4000);
      } else {
        expect(a.link.appendAt).toHaveLength(1);
      }
      expect(a.session.cancels).toBe(0);

      await vi.advanceTimersByTimeAsync(2 * SECOND);
      expect(ended).toEqual({ state: "failed", reason: "host_lost" });
      expect(Date.now() - callAt).toBeLessThan(LEASE_MS + 2 * SECOND);
      expect(a.link.appendAt.every((at) => at - callAt < LEASE_MS)).toBe(true);
      expect(a.session.cancels).toBe(1);
      expect(sessions[0]!.ended).toBe(1);
      expect(a.link.finished).toEqual([]);

      const attempts = a.link.appendAt.length;
      const signals = a.link.signals();
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(a.link.appendAt).toHaveLength(attempts);
      expect(a.link.signals()).toBe(signals);

      expect(agent.kills()).toBe(0);
      expect(b.session.cancels).toBe(0);
      b.session.say("still here");
      await vi.advanceTimersByTimeAsync(0);
      expect(b.link.appended).toHaveLength(1);
      b.session.end();
      expect((await b.settled).value).toEqual({ state: "done", stopReason: "end_turn" });
      expect(b.link.finished).toEqual([{ state: "done", stopReason: "end_turn" }]);
    },
    60_000,
  );

  it("T7-04 (b) runs a later turn on the same thread in the same session", async () => {
    const agent = fakeAgent();
    const { proxy } = fakeProxy();
    const first = await started("thread-a", agent, proxy);
    first.link.setMode("fail");
    first.session.say("thinking");
    await vi.advanceTimersByTimeAsync(LEASE_MS + SECOND);
    expect((await first.settled).value).toEqual({ state: "failed", reason: "host_lost" });

    const later = runTurn(claim("thread-a"), deps(fakeLink().link, agent, proxy));
    await until(() => first.session.prompts === 2);
    expect(agent.sessions).toHaveLength(1);
    first.session.end();
    expect(await later).toEqual({ state: "done", stopReason: "end_turn" });
  }, 60_000);

  it("T7-04 (e) rides out a 30 s outage and appends the item once, with the turn done", async () => {
    const agent = fakeAgent();
    const { proxy } = fakeProxy();
    const run = await started("thread-a", agent, proxy);
    run.link.setMode("fail");
    run.session.say("thinking");
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    run.link.setMode("ok");
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(run.link.appended).toHaveLength(1);

    run.session.end();
    expect((await run.settled).value).toEqual({ state: "done", stopReason: "end_turn" });
    expect(run.link.appended).toHaveLength(2);
    expect(new Set(run.link.appended).size).toBe(2);
    expect(run.link.finished).toEqual([{ state: "done", stopReason: "end_turn" }]);
  }, 60_000);

  it("logs host_append with the turn and item ids after each successful append, and none for a failed one", async () => {
    const log = join(dir, "daemon.log");
    openHostLog(log);
    const lines = () =>
      (existsSync(log) ? readFileSync(log, "utf8") : "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "host_append");
    const agent = fakeAgent();
    const { proxy } = fakeProxy();
    const run = await started("thread-a", agent, proxy);
    run.link.setMode("fail");
    run.session.say("thinking");
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(lines()).toEqual([]);

    run.link.setMode("ok");
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    const [line] = lines();
    expect(line).toMatchObject({ event: "host_append", itemIds: run.link.appended });
    expect(line!.turnId).toMatch(/^u\d+$/);
    expect(typeof line!.at).toBe("number");
    run.session.end();
    await run.outcome;
  }, 60_000);
});
