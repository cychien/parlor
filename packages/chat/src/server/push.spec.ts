import { asId } from "@parlor/core";
import type { DatabaseHandle } from "@parlor/data";
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

import type { ClaimedTurn } from "../model.js";
import type { PushedTurn } from "../protocol.js";
import type { HostSession } from "./actions.js";
import type { LiveRelay } from "./live.js";
import { turnPush } from "./push.js";
import {
  agentRef,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";
import type { ChatDb } from "./store.js";

const hello = (max: number) => ({
  protocols: { min: 2, max },
  hostVersion: "1.0.0",
  name: "Alice's Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
});

async function openHostStream(app: ChatServer, token: string) {
  const controller = new AbortController();
  const response = await app.server.fetch(
    new Request("http://app.test/_parlor/sync/stream?since=", {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "x-parlor-client": "host",
      },
      signal: controller.signal,
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { event: string; data: string }[] = [];
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          const lines = [...block.matchAll(/^data: (.*)$/gm)].map((match) => match[1]);
          frames.push({ event, data: lines.join("\n") });
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {}
  })();
  await vi.waitFor(() => expect(frames.some((f) => f.event === "handshake")).toBe(true));
  return {
    frames,
    pushed: () =>
      frames
        .filter((frame) => frame.event === "chat")
        .map((frame) => JSON.parse(frame.data) as PushedTurn),
    close: () => controller.abort(),
  };
}

describe.each(drivers)("pushed turns on $name", (driver) => {
  let handle: DatabaseHandle;
  let app: ChatServer;
  const closers: (() => void)[] = [];

  beforeAll(async () => {
    handle = await openDatabase(driver);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    app = serveChat(handle, { chat: { leaseMs: 60_000 } });
  }, 60_000);

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await app.server.close();
  });

  const send = (turnId: string) =>
    app.action("alice", "send", {
      threadId: "t1",
      turnId,
      itemId: `${turnId}-prompt`,
      clientId: "tab-1",
      prompt: { text: "hello", agent: agentRef },
    });

  it("claims a new turn for a listening computer and pushes it on its own stream only", async () => {
    expect((await app.action("alice-host", "hostHello", hello(3))).status).toBe(200);
    const mac = await openHostStream(app, "alice-host");
    closers.push(mac.close);
    expect(JSON.parse(mac.frames[0]!.data)).toMatchObject({ capabilities: ["chat"] });
    const pc = await openHostStream(app, "alice-host-2");
    closers.push(pc.close);

    expect((await send("u1")).status).toBe(200);
    await vi.waitFor(() => expect(mac.pushed()).toHaveLength(1));
    const [frame] = mac.pushed();
    expect(frame).toMatchObject({
      type: "claimed",
      turn: { id: "t1", turnId: "u1", clientId: "tab-1", agent: agentRef },
    });
    expect(frame!.turn.token).toBeDefined();
    expect(frame!.turn.context).toContain("parlor-context");
    expect(pc.pushed()).toEqual([]);

    const claim = await app.action("alice-host", "hostClaim", {});
    expect(claim.status).toBe(404);
    const append = await app.action("alice-host", "hostAppend", {
      turnId: "u1",
      items: [],
    });
    expect(append.status).toBe(200);
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "running" },
    ]);
  });

  it("leaves the turn for the claim of a computer on an older protocol", async () => {
    expect((await app.action("alice-host", "hostHello", hello(2))).status).toBe(200);
    const mac = await openHostStream(app, "alice-host");
    closers.push(mac.close);

    expect((await send("u1")).status).toBe(200);
    const claim = await app.action("alice-host", "hostClaim", {});
    expect(claim.status).toBe(200);
    expect(data(claim)).toMatchObject({ turnId: "u1" });
    expect(mac.pushed()).toEqual([]);
  });

  it("leaves the turn for the claim when the computer is not listening", async () => {
    expect((await app.action("alice-host", "hostHello", hello(3))).status).toBe(200);
    expect((await send("u1")).status).toBe(200);
    const claim = await app.action("alice-host", "hostClaim", {});
    expect(data(claim)).toMatchObject({ turnId: "u1" });
  });
});

describe("turnPush", () => {
  const owner = { scope: "alice", userId: asId("user", "alice") };
  const hostId = asId("host", "mac");
  const principal = {
    kind: "host" as const,
    userId: owner.userId,
    grantId: asId("grant", "g-mac"),
    hostId,
  };
  const turn = { id: asId("thread", "t1"), turnId: asId("turn", "u1") } as ClaimedTurn;

  function harness(send: (data: string) => void = () => {}) {
    const released: string[] = [];
    const relay = {
      computer: () => [{ clientId: "host", scope: "alice", principal, send }],
    } as unknown as LiveRelay;
    const session = {
      claim: vi.fn(async () => turn),
      release: vi.fn(async (_host: unknown, _threadId: unknown, turnId: string) => {
        released.push(turnId);
        return true;
      }),
    } as unknown as HostSession;
    const push = turnPush({ relay, session, db: () => ({}) as ChatDb, pickupMs: 1_000 });
    return { push, released, session };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a pushed turn its computer never confirms to the queue", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { push, released } = harness((frame) => sent.push(frame));
    push.offer(owner, hostId);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(released).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toEqual(["u1"]);
  });

  it("keeps a confirmed turn with its computer", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { push, released } = harness((frame) => sent.push(frame));
    push.offer(owner, hostId);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    push.confirm(turn.turnId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(released).toEqual([]);
  });

  it("returns the turn at once when the stream cannot take it", async () => {
    const { push, released } = harness(() => {
      throw new Error("closed");
    });
    push.offer(owner, hostId);
    await vi.waitFor(() => expect(released).toEqual(["u1"]));
  });
});
