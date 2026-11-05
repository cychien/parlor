import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asId } from "@parlor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConnection, AgentSession } from "./acp.js";
import type { ProxySession } from "./mcp-proxy.js";
import { createSessionPool, type LiveSession, type SessionPool } from "./pool.js";

const grant = { appOrigin: "https://app.example.com", grantId: asId("grant", "g1") };
const IDLE = 10 * 60_000;

let dir: string;
let pool: SessionPool;
let exit: () => void;
let opened = 0;

function connection(): AgentConnection {
  const exited = new Promise<never>((resolve) => {
    exit = () => resolve(undefined as never);
  });
  return {
    capabilities: { resume: false, close: true, mcpHttp: false, ready: true },
    exited,
    kill: async () => undefined,
    openSession: async () =>
      ({
        id: `s${++opened}`,
        resumed: false,
        close: vi.fn(async () => undefined),
      }) as unknown as AgentSession,
  };
}

async function warmSession(): Promise<LiveSession> {
  const agent = await pool.launch(grant.appOrigin, "claude", async () => connection());
  const session = await agent.openSession({
    cwd: "/tmp",
    mcpServers: [],
    pinAskMode: true,
  });
  return { session, proxy: { dispose: vi.fn() } as unknown as ProxySession };
}

const closed = (live: LiveSession) => [
  vi.mocked(live.session.close).mock.calls.length,
  vi.mocked(live.proxy.dispose).mock.calls.length,
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-pool-"));
  pool = createSessionPool(join(dir, "sessions.json"));
});

afterEach(async () => {
  vi.useRealTimers();
  await pool.drop(grant.appOrigin);
  await rm(dir, { recursive: true, force: true });
});

describe("a warm session", () => {
  it("goes to the first turn that asks under the same fit, and to no other", async () => {
    const live = await warmSession();
    pool.keepWarm(grant, "claude", live, "fit", IDLE);

    expect(pool.warm(grant, "claude", "fit", IDLE)).toBe(true);
    expect(pool.takeWarm(grant, "claude", "fit")).toBe(live);
    expect(pool.takeWarm(grant, "claude", "fit")).toBeUndefined();
    expect(pool.warm(grant, "claude", "fit", IDLE)).toBe(false);
    expect(closed(live)).toEqual([0, 0]);
  });

  it("is closed, not handed out, when the turn asks under another policy", async () => {
    const live = await warmSession();
    pool.keepWarm(grant, "claude", live, "ask before every action", IDLE);

    expect(pool.warm(grant, "claude", "auto", IDLE)).toBe(false);
    expect(pool.takeWarm(grant, "claude", "auto")).toBeUndefined();
    expect(closed(live)).toEqual([1, 1]);
  });

  it("closes once it waits untaken for the idle time, which each warm call restarts", async () => {
    vi.useFakeTimers();
    const live = await warmSession();
    pool.keepWarm(grant, "claude", live, "fit", IDLE);

    vi.advanceTimersByTime(IDLE - 1);
    expect(pool.warm(grant, "claude", "fit", IDLE)).toBe(true);
    vi.advanceTimersByTime(IDLE - 1);
    expect(closed(live)).toEqual([0, 0]);
    vi.advanceTimersByTime(1);
    expect(closed(live)).toEqual([1, 1]);
    expect(pool.takeWarm(grant, "claude", "fit")).toBeUndefined();
  });

  it("closes the one it replaces", async () => {
    const older = await warmSession();
    const newer = await warmSession();
    pool.keepWarm(grant, "claude", older, "fit", IDLE);
    pool.keepWarm(grant, "claude", newer, "fit", IDLE);

    expect(closed(older)).toEqual([1, 1]);
    expect(pool.takeWarm(grant, "claude", "fit")).toBe(newer);
  });

  it("goes with its process when the agent exits", async () => {
    const live = await warmSession();
    pool.keepWarm(grant, "claude", live, "fit", IDLE);

    exit();
    await vi.waitFor(() =>
      expect(pool.process(grant.appOrigin, "claude")).toBeUndefined(),
    );
    expect(pool.takeWarm(grant, "claude", "fit")).toBeUndefined();
    expect(vi.mocked(live.proxy.dispose)).toHaveBeenCalledOnce();
  });
});
