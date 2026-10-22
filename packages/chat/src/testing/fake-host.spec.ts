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

import {
  agentRef,
  type ChatServer,
  type HttpListener,
  listenHttp,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
} from "../server/spec-kit.js";
import { createFakeHost, type FakeHost } from "./index.js";

describe("createFakeHost over real HTTP", () => {
  let handle: DatabaseHandle;
  let app: ChatServer;
  let http: HttpListener;
  let host: FakeHost;
  const authorized: { method: string; url: string }[] = [];

  beforeAll(async () => {
    handle = await openDatabase({ name: "pglite" });
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    authorized.length = 0;
    app = serveChat(handle);
    http = await listenHttp(app.server);
    host = createFakeHost({
      origin: http.origin,
      name: "Fake Mac",
      authorize: (request) => {
        authorized.push(request);
        return "Bearer alice-host";
      },
    });
  }, 60_000);

  afterEach(async () => {
    await http.close();
    await app.server.close();
  });

  const send = (turnId: string, text = "hi") =>
    app.action("alice", "send", {
      threadId: "t1",
      turnId,
      itemId: `${turnId}-prompt`,
      clientId: "tab",
      prompt: { text, agent: agentRef },
    });

  it("says hello, claims nothing when nothing waits, and heartbeats", async () => {
    expect(await host.hello()).toEqual({
      id: "mac",
      accepted: true,
      protocol: 2,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      userActivity: true,
    });
    expect(await host.claim()).toBeUndefined();
    expect((await host.heartbeat()).status).toBe(204);
    expect(authorized.map((request) => request.url.replace(http.origin, ""))).toEqual([
      "/_parlor/chat/actions/hostHello",
      "/_parlor/chat/actions/hostClaim",
      "/_parlor/chat/heartbeat",
    ]);
    expect(authorized.every((request) => request.method === "POST")).toBe(true);
  });

  it("plays a script against a claimed turn: stream, append, finish", async () => {
    await host.hello();
    await send("u1", "write something");
    const claimed = await host.run([
      {
        kind: "stream",
        frames: [
          {
            type: "delta",
            itemId: asId("item", "u1.1"),
            kind: "reply",
            offset: 0,
            text: "Hello",
          },
        ],
      },
      {
        kind: "append",
        items: [
          { id: asId("item", "u1.1"), kind: "reply", body: { text: "Hello" } },
          {
            id: asId("item", "u1.2"),
            kind: "tool",
            body: {
              title: "Created task",
              tool: { kind: "app", name: "createTask" },
              status: "done",
            },
          },
        ],
      },
      { kind: "finish", outcome: { state: "done", stopReason: "end_turn" } },
    ]);
    expect(claimed).toMatchObject({
      turnId: "u1",
      id: "t1",
      prompt: { body: { text: "write something" } },
    });
    expect(
      await rows(
        handle,
        "select id, kind, seq::int as seq from parlor_chat_items order by seq",
      ),
    ).toEqual([
      { id: "u1-prompt", kind: "prompt", seq: 1 },
      { id: "u1.1", kind: "reply", seq: 2 },
      { id: "u1.2", kind: "tool", seq: 3 },
    ]);
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "done" },
    ]);
  });

  it("waits for the user's stop and then sees it", async () => {
    await host.hello();
    await send("u1");
    const running = host.run([
      { kind: "wait_for_cancel" },
      { kind: "finish", outcome: { state: "cancelled" } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.action("alice", "cancel", { threadId: "t1", turnId: "u1", itemId: "c1" });
    await running;
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "cancelled" },
    ]);
  });

  it("waits for the answer to an ask it appended (regression-guard)", async () => {
    await host.hello();
    await send("u1");
    const running = host.run([
      {
        kind: "append",
        items: [
          {
            id: asId("item", "u1.1"),
            kind: "ask",
            body: {
              question: "Run it?",
              choices: [{ id: "yes", label: "Yes", effect: "allow_once" }],
            },
          },
        ],
      },
      { kind: "wait_for_answer", askId: "u1.1" },
      { kind: "finish", outcome: { state: "done", stopReason: "end_turn" } },
    ]);
    await vi.waitFor(async () =>
      expect(
        await rows(handle, "select id from parlor_chat_items where kind = 'ask'"),
      ).toEqual([{ id: "u1.1" }]),
    );
    await app.action("alice", "answer", {
      threadId: "t1",
      turnId: "u1",
      itemId: "a1",
      answer: { askId: "u1.1", choice: "yes" },
    });
    await running;
    expect(await rows(handle, "select state from parlor_chat_turns")).toEqual([
      { state: "done" },
    ]);
  });

  it("surfaces a refusal as the framework's error", async () => {
    await expect(host.call("hostSignals", { turns: [] })).rejects.toMatchObject({
      code: "forbidden",
      message: "Say hello before anything else.",
    });
  });
});
