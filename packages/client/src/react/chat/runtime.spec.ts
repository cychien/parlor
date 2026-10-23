import type { AgentConfirmation, AgentUiClient } from "@parlor/agent-ui/client";
import type {
  CapabilityHandle,
  LocalAgentHost,
  PairingDevice,
} from "@parlor/capabilities";
import type {
  AnswerToSign,
  ChatSnapshot,
  HostSummary,
  ItemSignature,
  LoggedItem,
  PromptToSign,
  ThreadSummary,
  TurnStatus,
} from "@parlor/chat";
import { ActionError, asId, type Tag } from "@parlor/core";
import type { ClientChannel } from "@parlor/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceSource, HostAuthorizer } from "../../session.js";
import { createChatRuntime } from "./runtime.js";

const thread = (id: string, agent?: ThreadSummary["agent"]): ThreadSummary => ({
  id: asId("thread", id),
  title: id,
  agent,
  updatedAt: 1,
  lastSeq: 1,
});

const claudeOnMac = (online = true): HostSummary => ({
  id: asId("host", "host_mac"),
  name: "Alice's Mac",
  platform: "macos",
  online,
  agents: [{ id: "claude", name: "Claude Code", ready: true }],
});

const keysOf = (deviceId: string): PairingDevice => ({
  deviceId,
  name: "Hello on macOS",
  platform: "tauri",
  signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
});

const logged = (
  seq: number,
  id: string,
  kind: "prompt" | "reply",
  text: string,
  turn = "turn_1",
): LoggedItem =>
  kind === "prompt"
    ? {
        id: asId("item", id),
        threadId: asId("thread", "thr_1"),
        turnId: asId("turn", turn),
        seq,
        at: seq,
        author: "user",
        kind,
        body: { text, agent: { hostId: asId("host", "host_mac"), agentId: "claude" } },
      }
    : {
        id: asId("item", id),
        threadId: asId("thread", "thr_1"),
        turnId: asId("turn", turn),
        seq,
        at: seq,
        author: "agent",
        kind,
        body: { text },
      };

const turn = (id: string, state: TurnStatus["state"]): TurnStatus => ({
  turnId: asId("turn", id),
  state,
  agent: { hostId: asId("host", "host_mac"), agentId: "claude" },
});

function snapshot(overrides: Partial<ChatSnapshot["page"]> = {}): ChatSnapshot {
  return {
    threads: [thread("thr_1")],
    hosts: [claudeOnMac()],
    page: {
      thread: thread("thr_1"),
      items: [],
      open: [],
      turns: [],
      hasMore: false,
      ...overrides,
    },
  };
}

function setup(
  options: {
    open?: (input: { threadId?: string }) => Promise<ChatSnapshot>;
    items?: (afterSeq: number) => LoggedItem[];
    threadId?: string;
    localHost?: CapabilityHandle<LocalAgentHost>;
    auth?: Partial<DeviceSource & HostAuthorizer>;
    transport?: "sse" | "poll";
    hidden?: () => boolean;
    hosts?: () => HostSummary[];
  } = {},
) {
  let negotiatedTransport = options.transport;
  const negotiatedListeners = new Set<(transport: "sse" | "poll") => void>();
  const calls: { name: string; input: unknown }[] = [];
  const handlers: Record<string, (input: never) => unknown> = {
    open: options.open ?? (async () => snapshot()),
    items: (input: { afterSeq: number }) => options.items?.(input.afterSeq) ?? [],
    hosts: options.hosts ?? (() => [claudeOnMac()]),
    send: (input: { threadId: string }) => ({ id: input.threadId, turnId: "t" }),
    cancel: (input: { threadId: string }) => ({ id: input.threadId }),
    answer: (input: { threadId: string }) => ({ id: input.threadId }),
    userActive: () => ({ ok: true }),
  };
  const call = vi.fn(async (name: string, input: unknown) => {
    calls.push({ name, input });
    return handlers[name]!(input as never);
  });
  let channel: ClientChannel | undefined;
  const detachChannel = vi.fn();
  const tagListeners = new Set<(tags: readonly Tag[]) => void>();
  const resumeListeners = new Set<() => void>();
  const stopWatching = vi.fn();
  const watch = vi.fn(() => stopWatching);
  const confirmationListeners = new Set<() => void>();
  let confirmations: readonly AgentConfirmation[] = [];
  const agentUi = {
    watch,
    confirmations: {
      get: () => confirmations,
      subscribe: (listener: () => void) => {
        confirmationListeners.add(listener);
        return () => confirmationListeners.delete(listener);
      },
    },
  } as unknown as AgentUiClient;
  const runtime = createChatRuntime({
    calls: { call, invoke: vi.fn() } as never,
    clientId: "tab-1",
    appOrigin: "https://hello.test",
    agentUi,
    addChannel: (added) => {
      channel = added;
      return detachChannel;
    },
    onSyncTags: (listener) => {
      tagListeners.add(listener);
      return () => tagListeners.delete(listener);
    },
    onResume: (listener) => {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    transport: () => negotiatedTransport,
    onNegotiated: (listener) => {
      negotiatedListeners.add(listener);
      return () => negotiatedListeners.delete(listener);
    },
    isHidden: options.hidden,
    auth: options.auth,
    localHost: Promise.resolve(
      options.localHost ?? { available: false, reason: "no host" },
    ),
    threadId: options.threadId,
  });
  return {
    runtime,
    calls,
    call,
    watch,
    stopWatching,
    detachChannel,
    channel: () => channel!,
    frame: (frame: unknown) => channel!.receive(JSON.stringify(frame)),
    tags: (...tags: Tag[]) => {
      for (const listener of tagListeners) listener(tags);
    },
    resume: () => {
      for (const listener of resumeListeners) listener();
    },
    negotiate: (transport: "sse" | "poll") => {
      negotiatedTransport = transport;
      for (const listener of negotiatedListeners) listener(transport);
    },
    setConfirmations(next: readonly AgentConfirmation[]) {
      confirmations = next;
      for (const listener of confirmationListeners) listener();
    },
    names: () => calls.map((c) => c.name),
    shown: () =>
      runtime.get().items.map((item) => ({
        id: item.id,
        text: "text" in item ? item.text : undefined,
        streaming: "streaming" in item ? item.streaming : undefined,
      })),
  };
}

const flush = () => vi.waitFor(() => undefined);
const delta = (offset: number, text: string, itemId = "turn_1.1") => ({
  type: "delta",
  threadId: "thr_1",
  turnId: "turn_1",
  itemId,
  kind: "reply",
  offset,
  text,
});

describe("createChatRuntime start", () => {
  it("registers the chat channel, reads the newest thread and watches it", async () => {
    const h = setup({
      open: async () =>
        snapshot({
          items: [logged(1, "item_p", "prompt", "hi")],
          turns: [turn("turn_1", "done")],
        }),
    });
    expect(h.runtime.get().status).toBe("loading");
    h.runtime.start();
    expect(h.channel().event).toBe("chat");
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));

    expect(h.calls).toEqual([{ name: "open", input: {} }]);
    expect(h.shown()).toEqual([{ id: "item_p", text: "hi", streaming: undefined }]);
    expect(h.watch).toHaveBeenCalledWith("thr_1");
    expect(h.runtime.get().agents).toEqual([
      {
        key: "host_mac/claude",
        name: "Claude Code",
        hostName: "Alice's Mac",
        online: true,
        ready: true,
        problem: undefined,
      },
    ]);
    expect(h.runtime.get().agent?.key).toBe("host_mac/claude");
  });

  it("opens the thread it was given", async () => {
    const h = setup({ threadId: "thr_9" });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.calls[0]).toEqual({ name: "open", input: { threadId: "thr_9" } });
  });

  it("releases the channel, the sync subscription and the watch when stopped", async () => {
    const h = setup();
    const stop = h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    stop();
    expect(h.detachChannel).toHaveBeenCalledOnce();
    expect(h.stopWatching).toHaveBeenCalledOnce();
    h.tags(["parlor_chat", "thr_1"]);
    await flush();
    expect(h.names()).toEqual(["open"]);
  });

  it("reports unavailable instead of throwing when the backend has no chat", async () => {
    const h = setup({
      open: async () => {
        throw new ActionError("not_found", "Action request failed with HTTP 404");
      },
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("unavailable"));
    expect(h.runtime.get().items).toEqual([]);
    expect(h.runtime.get().agents).toEqual([]);
  });

  it("offers the install command for adding a computer when the shell cannot host one", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.runtime.get().connect).toEqual({
      kind: "command",
      command: "npx @parlor/agent-host connect https://hello.test",
    });
  });
});

describe("createChatRuntime reload mid-stream", () => {
  const reloaded = () =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "write a long reply")],
      open: [
        {
          turnId: asId("turn", "turn_1"),
          threadId: asId("thread", "thr_1"),
          items: [{ id: asId("item", "turn_1.1"), kind: "reply", text: "Hel" }],
        },
      ],
      turns: [turn("turn_1", "running")],
    });

  it("shows the open reply from the snapshot and appends later deltas from where it ended", async () => {
    const h = setup({ open: async () => reloaded() });
    h.runtime.start();
    h.channel().opened();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    h.frame(delta(0, "Hel"));
    h.frame(delta(3, "lo, "));
    h.frame(delta(3, "lo, "));
    h.frame(delta(7, "world"));
    expect(h.shown()).toEqual([
      { id: "item_p", text: "write a long reply", streaming: undefined },
      { id: "turn_1.1", text: "Hello, world", streaming: true },
    ]);
  });

  it("holds frames that arrive before the snapshot and applies them after it", async () => {
    let release!: (value: ChatSnapshot) => void;
    const h = setup({ open: () => new Promise((resolve) => (release = resolve)) });
    h.runtime.start();
    h.channel().opened();
    h.frame(delta(3, "lo"));
    h.frame(delta(5, ", world"));
    expect(h.shown()).toEqual([]);
    release(reloaded());
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    expect(h.shown().at(-1)).toEqual({
      id: "turn_1.1",
      text: "Hello, world",
      streaming: true,
    });
  });

  it("replaces the open reply with its persisted twin under the same id, once", async () => {
    let current = reloaded();
    const h = setup({ open: async () => current });
    h.runtime.start();
    h.channel().opened();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    h.frame(delta(3, "lo, world"));
    expect(h.shown().filter((item) => item.id === "turn_1.1")).toEqual([
      { id: "turn_1.1", text: "Hello, world", streaming: true },
    ]);

    current = snapshot({
      items: [
        logged(1, "item_p", "prompt", "write a long reply"),
        logged(2, "turn_1.1", "reply", "Hello, world"),
      ],
      turns: [turn("turn_1", "done")],
    });
    h.tags(["parlor_chat", "thr_1"]);
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.frame({ type: "settled", threadId: "thr_1", turnId: "turn_1" });
    expect(h.shown()).toEqual([
      { id: "item_p", text: "write a long reply", streaming: undefined },
      { id: "turn_1.1", text: "Hello, world", streaming: false },
    ]);
  });

  it("drops late deltas of an item that is already durable", async () => {
    const h = setup({
      open: async () =>
        snapshot({
          items: [
            logged(1, "item_p", "prompt", "go"),
            logged(2, "turn_1.1", "reply", "Hello"),
          ],
          turns: [turn("turn_1", "done")],
        }),
    });
    h.runtime.start();
    h.channel().opened();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.frame(delta(0, "Hel"));
    expect(h.shown().filter((item) => item.id === "turn_1.1")).toEqual([
      { id: "turn_1.1", text: "Hello", streaming: false },
    ]);
  });

  it("ignores frames of another thread", async () => {
    const h = setup({ open: async () => reloaded() });
    h.runtime.start();
    h.channel().opened();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    h.frame({ ...delta(3, "lo"), threadId: "thr_other" });
    expect(h.shown().at(-1)?.text).toBe("Hel");
  });
});

describe("createChatRuntime poll deployments", () => {
  const streaming = () =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "write a long reply")],
      open: [
        {
          turnId: asId("turn", "turn_1"),
          threadId: asId("thread", "thr_1"),
          items: [{ id: asId("item", "turn_1.1"), kind: "reply", text: "Hel" }],
        },
      ],
      turns: [turn("turn_1", "running")],
    });

  it("shows no in-flight text from the snapshot while the chat channel is not open", async () => {
    const h = setup({ open: async () => streaming() });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    expect(h.shown()).toEqual([
      { id: "item_p", text: "write a long reply", streaming: undefined },
    ]);
  });

  it("adopts the in-flight text once the chat channel opens, and drops nothing when it closes", async () => {
    const h = setup({ open: async () => streaming() });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));

    h.channel().opened();
    await vi.waitFor(() => expect(h.shown()).toHaveLength(2));
    expect(h.shown().at(-1)).toEqual({ id: "turn_1.1", text: "Hel", streaming: true });

    h.channel().closed();
    expect(h.shown()).toHaveLength(2);
  });

  it("shows every item from sync events alone, with nothing streaming", async () => {
    const store = [logged(1, "item_p", "prompt", "go")];
    const h = setup({
      open: async () => snapshot({ items: store, turns: [turn("turn_1", "done")] }),
      items: (afterSeq) => store.filter((item) => item.seq > afterSeq),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));

    store.push(
      logged(2, "turn_1.1", "reply", "first"),
      logged(3, "turn_1.2", "reply", "second"),
    );
    h.tags(["parlor_chat", "thr_1"]);
    await vi.waitFor(() => expect(h.shown()).toHaveLength(3));

    expect(h.calls.at(-1)).toEqual({
      name: "items",
      input: { threadId: "thr_1", afterSeq: 1 },
    });
    expect(h.shown()).toEqual([
      { id: "item_p", text: "go", streaming: undefined },
      { id: "turn_1.1", text: "first", streaming: false },
      { id: "turn_1.2", text: "second", streaming: false },
    ]);
  });

  it("re-reads the whole snapshot while a turn runs, to learn when it ends", async () => {
    let turns = [turn("turn_1", "running")];
    const h = setup({
      open: async () => snapshot({ items: [logged(1, "item_p", "prompt", "go")], turns }),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    turns = [turn("turn_1", "done")];
    h.tags(["parlor_chat", "thr_1"]);
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.names()).toEqual(["open", "open"]);
  });

  it("ignores sync events about other threads", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.tags(["parlor_chat", "thr_other"], ["tasks", "1"]);
    await flush();
    expect(h.names()).toEqual(["open"]);
  });

  it("re-reads the computers when their tag changes", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.tags(["parlor_chat_hosts"]);
    await vi.waitFor(() => expect(h.names()).toEqual(["open", "hosts"]));
  });

  it("re-reads the computers when a grant is added or revoked", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.tags(["parlor_auth_hosts", "host_mac"]);
    await vi.waitFor(() => expect(h.names()).toEqual(["open", "hosts"]));
  });
});

describe("createChatRuntime send", () => {
  it("posts the prompt with ids it minted, to the chosen agent and this tab", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("  write a long reply ");
    await h.runtime.send();

    const send = h.calls.find((c) => c.name === "send")!.input as {
      threadId: string;
      turnId: string;
      itemId: string;
      clientId: string;
      prompt: unknown;
    };
    expect(send.threadId).toBe("thr_1");
    expect(send.clientId).toBe("tab-1");
    expect(send.prompt).toEqual({
      text: "write a long reply",
      agent: { hostId: "host_mac", agentId: "claude" },
    });
    expect(new Set([send.turnId, send.itemId]).size).toBe(2);
    expect(h.runtime.get().draft).toBe("");
  });

  it("starts a thread of its own when there is none and watches it", async () => {
    const h = setup({ open: async () => snapshot({ thread: undefined }) });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");
    await h.runtime.send();
    const { threadId } = h.calls.find((c) => c.name === "send")!.input as {
      threadId: string;
    };
    expect(threadId).not.toBe("");
    expect(h.watch).toHaveBeenCalledWith(threadId);
    expect(h.calls.at(-1)).toEqual({ name: "open", input: { threadId } });
  });

  it("reuses its ids when the same text is sent again after a failure, so the retry is a no-op", async () => {
    const h = setup();
    let attempts = 0;
    h.call.mockImplementation(async (name: string, input: unknown) => {
      h.calls.push({ name, input });
      if (name === "send" && ++attempts === 1) throw new Error("network");
      if (name === "open") return snapshot();
      return { id: "thr_1" };
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");
    await expect(h.runtime.send()).rejects.toThrow("network");
    expect(h.runtime.get().draft).toBe("hello");
    expect(h.runtime.get().status).toBe("idle");
    await h.runtime.send();

    const sends = h.calls.filter((c) => c.name === "send").map((c) => c.input);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });

  it("does nothing for an empty draft or while no agent is online", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    await h.runtime.send();
    h.runtime.setDraft("   ");
    await h.runtime.send();
    expect(h.names()).toEqual(["open"]);
  });

  it("sends nothing for a prompt over the 32,000-character limit and sends the largest allowed one", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));

    h.runtime.setDraft("x".repeat(32_001));
    await h.runtime.send();
    expect(h.names()).toEqual(["open"]);
    expect(h.runtime.get().draft).toHaveLength(32_001);

    h.runtime.setDraft("x".repeat(32_000));
    await h.runtime.send();
    expect(h.names().filter((name) => name === "send")).toHaveLength(1);
  });

  it("is sending while the request is in flight and cannot be submitted twice", async () => {
    const h = setup();
    let finish!: () => void;
    h.call.mockImplementation(async (name: string, input: unknown) => {
      h.calls.push({ name, input });
      if (name === "send") await new Promise<void>((resolve) => (finish = resolve));
      if (name === "open") return snapshot();
      return { id: "thr_1" };
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");
    const first = h.runtime.send();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("sending"));
    await h.runtime.send();
    finish();
    await first;
    expect(h.calls.filter((c) => c.name === "send")).toHaveLength(1);
  });
});

describe("createChatRuntime switching threads", () => {
  const twoAgents: HostSummary = {
    ...claudeOnMac(),
    agents: [
      { id: "claude", name: "Claude Code", ready: true },
      { id: "codex", name: "Codex", ready: true },
    ],
  };
  const inThread = (id: string) => ({
    ...snapshot({
      thread: thread(id),
      turns: [turn(`turn_of_${id}`, "running")],
    }),
    hosts: [twoAgents],
    threads: [thread("thr_1"), thread("thr_2")],
  });
  const switching = (options: { sendFails?: boolean } = {}) => {
    const sent: { threadId: string; turnId: string; itemId: string }[] = [];
    const cancels: { threadId: string; turnId: string; itemId: string }[] = [];
    let failures = 0;
    const h = setup();
    h.call.mockImplementation(async (name: string, input: unknown) => {
      h.calls.push({ name, input });
      if (name === "open") {
        return inThread((input as { threadId?: string }).threadId ?? "thr_1");
      }
      if (name === "send") {
        sent.push(input as (typeof sent)[number]);
        if (options.sendFails && ++failures === 1) throw new Error("network");
      }
      if (name === "cancel") {
        cancels.push(input as (typeof cancels)[number]);
        if (cancels.length === 1) throw new Error("network");
      }
      return { id: "x" };
    });
    return { h, sent, cancels };
  };

  it("sends a prompt that failed in one thread to the thread that is open when it is sent again", async () => {
    const { h, sent } = switching({ sendFails: true });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_1"));
    h.runtime.setDraft("hello");
    await expect(h.runtime.send()).rejects.toThrow("network");

    h.runtime.openThread("thr_2");
    await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_2"));
    await h.runtime.send();

    expect(sent.map((s) => s.threadId)).toEqual(["thr_1", "thr_2"]);
    expect(sent[1]!.turnId).not.toBe(sent[0]!.turnId);
    expect(sent[1]!.itemId).not.toBe(sent[0]!.itemId);
    expect(h.runtime.get().thread?.id).toBe("thr_2");
  });

  it("sends a failed prompt to a different agent as a new prompt", async () => {
    const { h, sent } = switching({ sendFails: true });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    h.runtime.setDraft("hello");
    await expect(h.runtime.send()).rejects.toThrow("network");
    h.runtime.choose("host_mac/codex");
    await h.runtime.send();

    expect(sent.map((s) => s.threadId)).toEqual(["thr_1", "thr_1"]);
    expect(sent[1]!.turnId).not.toBe(sent[0]!.turnId);
    expect(sent[1]!.itemId).not.toBe(sent[0]!.itemId);
  });

  it("makes a stop retried after visiting another thread a new request", async () => {
    const { h, cancels } = switching();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    await expect(h.runtime.stop()).rejects.toThrow("network");

    h.runtime.openThread("thr_2");
    await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_2"));
    h.runtime.openThread("thr_1");
    await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_1"));
    await h.runtime.stop();

    expect(cancels.map((c) => c.threadId)).toEqual(["thr_1", "thr_1"]);
    expect(cancels[1]!.itemId).not.toBe(cancels[0]!.itemId);
  });

  it("stays in the thread the user opened while a send is still in flight", async () => {
    const { h } = switching();
    let finish!: () => void;
    const inner = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (name: string, input: unknown) => {
      if (name === "send") {
        h.calls.push({ name, input });
        await new Promise<void>((resolve) => (finish = resolve));
        return { id: "thr_1" };
      }
      return inner(name, input);
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_1"));
    h.runtime.setDraft("hello");
    const sending = h.runtime.send();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("sending"));
    h.runtime.openThread("thr_2");
    await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_2"));
    finish();
    await sending;
    await flush();
    expect(h.runtime.get().thread?.id).toBe("thr_2");
    expect(h.calls.filter((c) => c.name === "open").at(-1)?.input).toEqual({
      threadId: "thr_2",
    });
  });
});

describe("createChatRuntime a new thread", () => {
  const several = () =>
    setup({
      open: async (input) => ({
        ...snapshot({
          thread: thread(input.threadId ?? "thr_1"),
          items: [logged(1, "item_p", "prompt", "earlier")],
          turns: [turn("turn_1", "done")],
        }),
        threads: [thread("thr_2"), thread("thr_1")],
      }),
    });

  it("starts blank beside the older threads, keeping the computers and the draft", async () => {
    const h = several();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("half typed");
    h.runtime.newThread();

    const state = h.runtime.get();
    expect(state.status).toBe("idle");
    expect(state.thread).toBeUndefined();
    expect(state.items).toEqual([]);
    expect(state.threads.map((t) => t.id)).toEqual(["thr_2", "thr_1"]);
    expect(state.agents.map((a) => a.key)).toEqual(["host_mac/claude"]);
    expect(state.draft).toBe("half typed");
    expect(h.names()).toEqual(["open"]);
    expect(h.stopWatching).toHaveBeenCalledOnce();
  });

  it("creates the thread with the first prompt and moves into it", async () => {
    const h = several();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.newThread();
    h.runtime.setDraft("a fresh start");
    await h.runtime.send();

    const { threadId } = h.calls.find((c) => c.name === "send")!.input as {
      threadId: string;
    };
    expect(["thr_1", "thr_2"]).not.toContain(threadId);
    expect(h.watch).toHaveBeenLastCalledWith(threadId);
    expect(h.calls.at(-1)).toEqual({ name: "open", input: { threadId } });
  });

  it("is not moved to another thread by a sync event while it is blank, only its list is refreshed", async () => {
    let listed = [thread("thr_2"), thread("thr_1")];
    const h = setup({
      open: async (input) => ({
        ...snapshot({ thread: thread(input.threadId ?? "thr_2") }),
        threads: listed,
      }),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.newThread();
    h.runtime.setDraft("typing");
    listed = [thread("thr_3"), thread("thr_2"), thread("thr_1")];
    h.tags(["parlor_chat", "thr_3"]);

    await vi.waitFor(() =>
      expect(h.runtime.get().threads.map((t) => t.id)).toEqual([
        "thr_3",
        "thr_2",
        "thr_1",
      ]),
    );
    expect(h.runtime.get().thread).toBeUndefined();
    expect(h.runtime.get().draft).toBe("typing");
    expect(h.watch).toHaveBeenCalledTimes(1);
  });

  describe("when the user has no thread yet", () => {
    const withoutThreads = () => {
      let created = false;
      const h = setup({
        open: async () =>
          created
            ? { ...snapshot(), threads: [thread("thr_1")] }
            : { ...snapshot({ thread: undefined }), threads: [] },
      });
      return { h, create: () => (created = true) };
    };

    it("is not moved by a sync event while a draft is typed", async () => {
      const { h, create } = withoutThreads();
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      h.runtime.setDraft("typing");
      create();
      h.tags(["parlor_chat", "thr_1"]);
      await vi.waitFor(() => expect(h.runtime.get().threads).toHaveLength(1));
      expect(h.runtime.get().thread).toBeUndefined();
    });

    it("follows the thread another client starts when nothing is typed", async () => {
      const { h, create } = withoutThreads();
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      create();
      h.tags(["parlor_chat", "thr_1"]);
      await vi.waitFor(() => expect(h.runtime.get().thread?.id).toBe("thr_1"));
    });
  });

  it("stays blank when asked for while the first read is still running", async () => {
    const release: ((value: ChatSnapshot) => void)[] = [];
    const h = setup({ open: () => new Promise((resolve) => release.push(resolve)) });
    h.runtime.start();
    h.runtime.newThread();
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release[0]!({ ...snapshot(), threads: [thread("thr_stale")] });
    release[1]!({ ...snapshot(), threads: [thread("thr_1")] });
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.runtime.get().thread).toBeUndefined();
    expect(h.runtime.get().threads.map((t) => t.id)).toEqual(["thr_1"]);
  });
});

describe("createChatRuntime stop and answer", () => {
  const running = () =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "go")],
      turns: [turn("turn_1", "running")],
    });

  it("cancels the running turn", async () => {
    const h = setup({ open: async () => running() });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    await h.runtime.stop();
    const cancel = h.calls.find((c) => c.name === "cancel")!.input as Record<
      string,
      string
    >;
    expect(cancel.threadId).toBe("thr_1");
    expect(cancel.turnId).toBe("turn_1");
    expect(cancel.itemId).not.toBe("");
  });

  it("does not cancel when nothing runs", async () => {
    const h = setup();
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    await h.runtime.stop();
    expect(h.names()).toEqual(["open"]);
  });
});

describe("createChatRuntime command failures", () => {
  const running = () =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "go")],
      turns: [turn("turn_1", "running")],
    });

  function failing(
    name: string,
    error: Error,
    options: Parameters<typeof setup>[0] = {},
  ) {
    const h = setup(options);
    let broken = true;
    h.call.mockImplementation(async (called: string, input: unknown) => {
      h.calls.push({ name: called, input });
      if (called === name && broken) throw error;
      if (called === "open") return options.open ? options.open() : snapshot();
      return { id: "thr_1" };
    });
    return { h, repair: () => (broken = false) };
  }

  it("shows the server's reason when a send is refused, and clears it after a send that works", async () => {
    const { h, repair } = failing(
      "send",
      new ActionError("invalid_input", "Alice's Mac is offline."),
    );
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.runtime.get().error).toBeUndefined();

    h.runtime.setDraft("hello");
    await expect(h.runtime.send()).rejects.toThrow("Alice's Mac is offline.");
    expect(h.runtime.get().error).toBe("Alice's Mac is offline.");
    expect(h.runtime.get().draft).toBe("hello");

    repair();
    await h.runtime.send();
    expect(h.runtime.get().error).toBeUndefined();
  });

  it("says the server could not be reached when the request itself fails", async () => {
    const { h } = failing("send", new TypeError("Failed to fetch"));
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");

    await expect(h.runtime.send()).rejects.toThrow("Failed to fetch");

    expect(h.runtime.get().error).toBe("Could not reach the server.");
  });

  it("names the limit when the server rejects an over-long prompt", async () => {
    const { h } = failing(
      "send",
      new ActionError("invalid_input", 'Invalid input for "send"', {
        issues: [
          {
            code: "too_big",
            origin: "string",
            maximum: 32_000,
            inclusive: true,
            path: ["prompt", "text"],
            message: "Too big: expected string to have <=32000 characters",
          },
        ],
      }),
    );
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");

    await expect(h.runtime.send()).rejects.toThrow();

    expect(h.runtime.get().error).toBe("Messages can be at most 32,000 characters.");
  });

  it("never shows the raw schema message for any other rejected input", async () => {
    const { h } = failing(
      "send",
      new ActionError("invalid_input", 'Invalid input for "send"', {
        issues: [
          {
            code: "invalid_type",
            expected: "string",
            path: ["clientId"],
            message: "Invalid input: expected string, received undefined",
          },
        ],
      }),
    );
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");

    await expect(h.runtime.send()).rejects.toThrow();

    expect(h.runtime.get().error).toBe("That message could not be sent. Try again.");
  });

  it("shows a refused stop and clears it when the next stop works", async () => {
    const { h, repair } = failing(
      "cancel",
      new ActionError("not_found", "Turn not found"),
      { open: async () => running() },
    );
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));

    await expect(h.runtime.stop()).rejects.toThrow("Turn not found");
    expect(h.runtime.get().error).toBe("Turn not found");

    repair();
    await h.runtime.stop();
    expect(h.runtime.get().error).toBeUndefined();
  });

  it("keeps a failure shown while a read that is not a command succeeds", async () => {
    const { h } = failing("send", new ActionError("invalid_input", "Offline."));
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("hello");
    await expect(h.runtime.send()).rejects.toThrow("Offline.");

    h.tags(["parlor_chat", "thr_1"]);
    await flush();

    expect(h.runtime.get().error).toBe("Offline.");
  });
});

describe("createChatRuntime confirmations", () => {
  it("hands the folded list only the confirmations of its own thread", async () => {
    const h = setup({
      open: async () =>
        snapshot({
          items: [logged(1, "item_p", "prompt", "go")],
          turns: [turn("turn_1", "running")],
        }),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    const card = (id: string, threadId: string | undefined) =>
      ({ id, threadId }) as unknown as AgentConfirmation;
    h.setConfirmations([
      card("c1", "thr_1"),
      card("c2", "thr_other"),
      card("c3", undefined),
    ]);
    expect(h.shown()).toEqual([
      { id: "item_p", text: "go", streaming: undefined },
      { id: "c1", text: undefined, streaming: undefined },
    ]);
  });
});

describe("createChatRuntime recovery", () => {
  it("re-reads after the first load when a sync event arrived while it was loading", async () => {
    const store = [logged(1, "item_p", "prompt", "go")];
    let release!: (value: ChatSnapshot) => void;
    const h = setup({
      open: () => new Promise((resolve) => (release = resolve)),
      items: (afterSeq) => store.filter((item) => item.seq > afterSeq),
    });
    h.runtime.start();
    h.tags(["parlor_chat", "thr_1"]);
    store.push(logged(2, "turn_1.1", "reply", "late"));
    release(snapshot({ items: [store[0]!], turns: [turn("turn_1", "done")] }));
    await vi.waitFor(() => expect(h.shown()).toHaveLength(2));
    expect(h.calls.at(-1)).toEqual({
      name: "items",
      input: { threadId: "thr_1", afterSeq: 1 },
    });
  });

  it("tries the first read again on the next sync event after it failed", async () => {
    let failing = true;
    const h = setup({
      open: async () => {
        if (failing) throw new Error("network");
        return snapshot();
      },
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("unavailable"));
    failing = false;
    h.tags(["parlor_chat_hosts"]);
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
  });
});

describe("createChatRuntime adding a computer", () => {
  it("pairs through the local host when the shell has one and the session can authorize", async () => {
    const connect = vi.fn(async () => ({ connected: true as const }));
    const authorizeHost = vi.fn(async () => "code");
    const h = setup({
      localHost: {
        available: true,
        platform: "tauri",
        api: { status: async () => ({ state: "stopped" as const }), connect },
      },
      auth: { authorizeHost },
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().connect.kind).toBe("here"));
    const option = h.runtime.get().connect;
    if (option.kind !== "here") throw new Error("expected a local host");
    await option.start();
    expect(connect).toHaveBeenCalledWith({
      appOrigin: "https://hello.test",
      authorize: authorizeHost,
    });
    expect(h.names()).toEqual(["open", "hosts"]);
  });

  it("pins this app's own device at pairing by handing the host its public keys", async () => {
    const connect = vi.fn(async () => ({ connected: true as const }));
    const authorizeHost = vi.fn(async () => "code");
    const signAnswer = vi.fn();
    const h = setup({
      localHost: {
        available: true,
        platform: "tauri",
        api: { status: async () => ({ state: "stopped" as const }), connect },
      },
      auth: {
        authorizeHost,
        device: async () => ({
          id: asId("device", "dev_1"),
          keys: keysOf("dev_1"),
          signPrompt: vi.fn(),
          signAnswer,
        }),
      },
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().connect.kind).toBe("here"));
    const option = h.runtime.get().connect;
    if (option.kind !== "here") throw new Error("expected a local host");
    await option.start();
    expect(connect).toHaveBeenCalledWith({
      appOrigin: "https://hello.test",
      authorize: authorizeHost,
      device: keysOf("dev_1"),
    });
  });
});

describe("createChatRuntime device signatures", () => {
  const deviceId = asId("device", "dev_1");
  const signature = (presence: "none" | "user"): ItemSignature => ({
    deviceId,
    at: 1,
    signature: {
      keyId: "k",
      presence,
      format: presence === "user" ? "webauthn" : "es256-raw",
      signature: "s",
    },
  });
  const device = () => {
    const signPrompt = vi.fn(async (_prompt: PromptToSign) => signature("none"));
    const signAnswer = vi.fn(
      async (_answer: AnswerToSign, options: { presence: boolean }) =>
        signature(options.presence ? "user" : "none"),
    );
    const source = {
      device: vi.fn(async () => ({
        id: deviceId,
        keys: keysOf("dev_1"),
        signPrompt,
        signAnswer,
      })),
    };
    return { signPrompt, signAnswer, source };
  };
  const itemOf = (
    seq: number,
    id: string,
    kind: "ask" | "event",
    body: unknown,
    turnId = "turn_1",
  ) =>
    ({
      id: asId("item", id),
      threadId: asId("thread", "thr_1"),
      turnId: asId("turn", turnId),
      seq,
      at: seq,
      author: kind === "ask" ? "agent" : "system",
      kind,
      body,
    }) as unknown as LoggedItem;
  const askOf = (approval?: "presence" | "computer") =>
    itemOf(2, "turn_1.1", "ask", {
      question: "Run it?",
      choices: [{ id: "yes", label: "Yes", effect: "allow_once" }],
      ...(approval ? { approval } : {}),
    });
  const asking = (approval?: "presence" | "computer", more: LoggedItem[] = []) =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "go"), askOf(approval), ...more],
      turns: [turn("turn_1", "running")],
    });
  const answerCalls = (h: ReturnType<typeof setup>) =>
    h.calls.filter((call) => call.name === "answer").map((call) => call.input) as {
      itemId: string;
      answer: { signed?: ItemSignature };
    }[];

  it("signs the prompt it sends with the device, over the facts the host rebuilds it from", async () => {
    const d = device();
    const h = setup({ auth: d.source });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.runtime.setDraft("  write a long reply ");
    await h.runtime.send();
    const send = h.calls.find((c) => c.name === "send")!.input as {
      threadId: string;
      turnId: string;
      prompt: unknown;
    };
    expect(d.signPrompt).toHaveBeenCalledWith({
      threadId: send.threadId,
      turnId: send.turnId,
      agent: { hostId: "host_mac", agentId: "claude" },
      text: "write a long reply",
    });
    expect(send.prompt).toEqual({
      text: "write a long reply",
      agent: { hostId: "host_mac", agentId: "claude" },
      signed: signature("none"),
    });
  });

  it("sends an unsigned prompt where the device cannot sign", async () => {
    const h = setup({ auth: { device: async () => undefined } });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    await h.runtime.send("hi");
    expect(h.calls.find((c) => c.name === "send")!.input).toMatchObject({
      prompt: { text: "hi" },
    });
    expect(
      (h.calls.find((c) => c.name === "send")!.input as { prompt: object }).prompt,
    ).not.toHaveProperty("signed");
  });

  it("recognizes the prompts it signed as its own", async () => {
    const d = device();
    const signed = logged(1, "item_p", "prompt", "go") as LoggedItem<"prompt">;
    const mine = {
      ...signed,
      body: { ...signed.body, signed: signature("none") },
    } as LoggedItem;
    const h = setup({
      auth: d.source,
      open: async () => snapshot({ items: [mine], turns: [turn("turn_1", "done")] }),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.runtime.get().items[0]).toMatchObject({ kind: "prompt", mine: false });
    await h.runtime.send("another");
    expect(h.runtime.get().items[0]).toMatchObject({ kind: "prompt", mine: true });
  });

  it("asks the device for presence before it answers a presence question", async () => {
    const d = device();
    const h = setup({ auth: d.source, open: async () => asking("presence") });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(2));
    await h.runtime.answer("turn_1.1", "yes");
    expect(d.signAnswer).toHaveBeenCalledWith(
      { threadId: "thr_1", askId: "turn_1.1", choice: "yes" },
      { presence: true },
    );
    expect(answerCalls(h)[0]!.answer).toEqual({
      askId: "turn_1.1",
      choice: "yes",
      signed: signature("user"),
    });
  });

  it("signs an answer to an ordinary question without presence", async () => {
    const d = device();
    const h = setup({ auth: d.source, open: async () => asking() });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(2));
    await h.runtime.answer("turn_1.1", "yes", { name: "x" });
    expect(d.signAnswer).toHaveBeenCalledWith(
      { threadId: "thr_1", askId: "turn_1.1", choice: "yes", values: { name: "x" } },
      { presence: false },
    );
  });

  it("does not answer a presence question from a device that cannot sign", async () => {
    const h = setup({
      auth: { device: async () => undefined },
      open: async () => asking("presence"),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(2));
    await expect(h.runtime.answer("turn_1.1", "yes")).rejects.toThrow();
    expect(answerCalls(h)).toEqual([]);
    expect(h.runtime.get().error).toMatch(/confirm it is you/);
  });

  it("never answers a question that is answered on the computer", async () => {
    const d = device();
    const h = setup({ auth: d.source, open: async () => asking("computer") });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(2));
    await expect(h.runtime.answer("turn_1.1", "yes")).rejects.toThrow(/on your computer/);
    expect(answerCalls(h)).toEqual([]);
    expect(d.signAnswer).not.toHaveBeenCalled();
  });

  it("says the presence check was cancelled when the user declines it", async () => {
    const d = device();
    d.signAnswer.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    const h = setup({ auth: d.source, open: async () => asking("presence") });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(2));
    await expect(h.runtime.answer("turn_1.1", "yes")).rejects.toThrow();
    expect(h.runtime.get().error).toBe("The presence check was cancelled.");
    expect(answerCalls(h)).toEqual([]);
  });

  it("answers again with a new item once the host rejected the first answer", async () => {
    const d = device();
    let rejected = false;
    const rejection = itemOf(4, "turn_1.2", "event", {
      event: "answer_rejected",
      itemId: "item_a1",
    });
    const h = setup({
      auth: d.source,
      open: async () => asking("presence", rejected ? [rejection] : []),
      items: () => (rejected ? [rejection] : []),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(2));
    await h.runtime.answer("turn_1.1", "yes");
    rejected = true;
    h.tags(["parlor_chat", "thr_1"]);
    await vi.waitFor(() =>
      expect(h.runtime.get().items.find((item) => item.kind === "ask")).toMatchObject({
        answer: { state: "open" },
      }),
    );
    await h.runtime.answer("turn_1.1", "yes");
    const [first, second] = answerCalls(h);
    expect(second!.itemId).not.toBe(first!.itemId);
  });

  it("is waiting while the computer asks about this device, and running once the agent speaks", async () => {
    const pending = itemOf(2, "turn_1.1", "event", { event: "device_pending" });
    const spoke = logged(3, "turn_1.2", "reply", "hi");
    let page = [logged(1, "item_p", "prompt", "go"), pending];
    const h = setup({
      open: async () => snapshot({ items: page, turns: [turn("turn_1", "running")] }),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("waiting"));
    page = [...page, spoke];
    h.tags(["parlor_chat", "thr_1"]);
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
  });

  it("is not waiting once the computer refused the device", async () => {
    const h = setup({
      open: async () =>
        snapshot({
          items: [
            logged(1, "item_p", "prompt", "go"),
            itemOf(2, "turn_1.1", "event", { event: "device_pending" }),
            itemOf(3, "turn_1.2", "event", { event: "device_rejected" }),
          ],
          turns: [{ ...turn("turn_1", "failed"), failure: "device_rejected" }],
        }),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.runtime.get().items[0]).toMatchObject({ failure: "device_rejected" });
  });
  describe("setting up a browser before its first prompt", () => {
    const needingSetup = (cancelFirst = false) => {
      const d = device();
      let cancel = cancelFirst;
      const enroll = d.source.device;
      const source = {
        deviceSetup: vi.fn(async () => "needed" as const),
        device: vi.fn(async (options?: { readonly presence?: boolean }) => {
          if (cancel) {
            cancel = false;
            throw Object.assign(new Error("The passkey was not created."), {
              name: "PresenceSetupCancelled",
            });
          }
          return enroll(options);
        }),
      };
      return { ...d, source };
    };
    const sends = (h: ReturnType<typeof setup>) =>
      h.calls.filter((call) => call.name === "send");
    const explained = (auth: NonNullable<Parameters<typeof setup>[0]>["auth"]) => {
      const h = setup({ auth });
      h.runtime.explainSetup();
      return h;
    };

    it("explains the passkey before the first prompt, then sends it once set up", async () => {
      const d = needingSetup();
      const h = explained(d.source);
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      h.runtime.setDraft("hi");
      await h.runtime.send();
      expect(h.runtime.get().setup).toEqual({ step: "explain" });
      expect(d.source.device).not.toHaveBeenCalled();
      expect(sends(h)).toEqual([]);
      expect(h.runtime.get().draft).toBe("hi");

      await h.runtime.setUpDevice({ passkey: true });
      expect(d.source.device).toHaveBeenCalledWith({ presence: true });
      expect(h.runtime.get().setup).toBeUndefined();
      expect(sends(h)).toHaveLength(1);
      expect(h.runtime.get().draft).toBe("");
    });

    it("keeps the prompt waiting when the passkey is cancelled, and sends it set up without one", async () => {
      const d = needingSetup(true);
      const h = explained(d.source);
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      h.runtime.setDraft("hi");
      await h.runtime.send();
      await h.runtime.setUpDevice({ passkey: true });
      expect(h.runtime.get().setup).toEqual({ step: "cancelled" });
      expect(h.runtime.get().error).toBeUndefined();
      expect(sends(h)).toEqual([]);

      await h.runtime.setUpDevice({ passkey: false });
      expect(d.source.device).toHaveBeenCalledWith({ presence: false });
      expect(h.runtime.get().setup).toBeUndefined();
      expect(sends(h)).toHaveLength(1);
    });

    it("sends nothing and keeps the draft when the setup is dismissed", async () => {
      const d = needingSetup();
      const h = explained(d.source);
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      h.runtime.setDraft("hi");
      await h.runtime.send();
      h.runtime.dismissSetup();
      expect(h.runtime.get().setup).toBeUndefined();
      expect(h.runtime.get().draft).toBe("hi");
      await h.runtime.setUpDevice({ passkey: true });
      expect(d.source.device).not.toHaveBeenCalled();
      expect(sends(h)).toEqual([]);
    });

    it("enrolls directly, as before, when no UI explains the setup", async () => {
      const d = needingSetup();
      const h = setup({ auth: d.source });
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      await h.runtime.send("hi");
      expect(h.runtime.get().setup).toBeUndefined();
      expect(d.source.device).toHaveBeenCalled();
      expect(sends(h)).toHaveLength(1);
    });

    it("drops a waiting setup when the last UI explaining it goes away", async () => {
      const d = needingSetup();
      const h = setup({ auth: d.source });
      const stop = h.runtime.explainSetup();
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      await h.runtime.send("hi");
      expect(h.runtime.get().setup).toEqual({ step: "explain" });
      stop();
      expect(h.runtime.get().setup).toBeUndefined();
    });

    it("asks nothing once the device is set up", async () => {
      const d = needingSetup();
      const h = explained(d.source);
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
      await h.runtime.send("first");
      await h.runtime.setUpDevice({ passkey: true });
      await h.runtime.send("second");
      expect(h.runtime.get().setup).toBeUndefined();
      expect(sends(h)).toHaveLength(2);
    });
  });
});

describe("createChatRuntime linking this device", () => {
  const reporting = (devices: string[]) => ({
    ...snapshot(),
    hosts: [{ ...claudeOnMac(), devices }],
  });
  const linker = (
    state: { deviceId?: string; vouched: boolean; pairing: boolean },
    start = vi.fn(async (_options?: { readonly presence?: boolean }) => ({
      deviceId: "dev_new",
      code: "K7M4PX2Q8R",
      commitment: "c0mm1tment",
      expiresAt: "2026-10-24T10:15:00.000Z",
    })),
  ) => {
    let current = state;
    return {
      set: (next: typeof state) => (current = next),
      start,
      source: {
        linkState: vi.fn(async () => current),
        startLink: start,
      },
    };
  };

  it("needs no link where no computer says which devices it runs prompts from", async () => {
    const l = linker({ vouched: false, pairing: false });
    const h = setup({ auth: l.source });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    expect(h.runtime.get().link).toEqual({ status: "linked" });
  });

  it("asks an unlinked device to link, shows its code, and lets it send once a linked device vouches", async () => {
    const l = linker({ vouched: false, pairing: false });
    const h = setup({ auth: l.source, open: async () => reporting(["dev_laptop"]) });
    h.runtime.start();
    await vi.waitFor(() =>
      expect(h.runtime.get().link).toEqual({
        status: "unlinked",
        hostName: "Alice's Mac",
        code: undefined,
        expiresAt: undefined,
        busy: false,
        error: undefined,
      }),
    );
    await h.runtime.startLink();
    expect(l.start).toHaveBeenCalledWith(undefined);
    expect(h.runtime.get().link).toMatchObject({
      status: "unlinked",
      code: "K7M4PX2Q8R",
      qr: "https://hello.test/link#d=dev_new&c=c0mm1tment",
      expiresAt: "2026-10-24T10:15:00.000Z",
    });
    l.set({ deviceId: "dev_new", vouched: true, pairing: false });
    h.tags(["parlor_auth_devices", "dev_new"]);
    await vi.waitFor(() => expect(h.runtime.get().link).toEqual({ status: "linked" }));
  });

  it("is linked when a computer runs its prompts, or when it approved connect there", async () => {
    for (const state of [
      { deviceId: "dev_laptop", vouched: false, pairing: false },
      { vouched: false, pairing: true },
    ]) {
      const h = setup({
        auth: linker(state).source,
        open: async () => reporting(["dev_laptop"]),
      });
      h.runtime.start();
      await vi.waitFor(() => expect(h.runtime.get().link).toEqual({ status: "linked" }));
    }
  });

  it("says Face ID or Touch ID was cancelled, and links without it when asked", async () => {
    const start = vi.fn(async (options?: { readonly presence?: boolean }) => {
      if (options?.presence !== false) {
        throw Object.assign(new Error("The passkey was not created."), {
          name: "PresenceSetupCancelled",
        });
      }
      return {
        deviceId: "dev_new",
        code: "K7M4PX2Q8R",
        expiresAt: "2026-10-24T10:15:00.000Z",
      };
    });
    const l = linker({ vouched: false, pairing: false }, start);
    const h = setup({ auth: l.source, open: async () => reporting(["dev_laptop"]) });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().link.status).toBe("unlinked"));
    await h.runtime.startLink();
    expect(h.runtime.get().link).toMatchObject({
      error: "Face ID or Touch ID was cancelled. Try again, or link without it.",
    });
    await h.runtime.startLink({ presence: false });
    expect(h.runtime.get().link).toMatchObject({ code: "K7M4PX2Q8R", error: undefined });
  });
});

describe("createChatRuntime resend", () => {
  const expired = () =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "add milk")],
      turns: [{ ...turn("turn_1", "failed"), failure: "prompt_expired" }],
    });

  it("sends the same text to the same agent as a new turn in the thread, signed again", async () => {
    const signPrompt = vi.fn(async () => ({
      deviceId: asId("device", "dev_1"),
      at: 2,
      signature: {
        keyId: "k",
        presence: "none" as const,
        format: "es256-raw" as const,
        signature: "s",
      },
    }));
    const h = setup({
      open: async () => expired(),
      auth: {
        device: async () => ({
          id: asId("device", "dev_1"),
          keys: keysOf("dev_1"),
          signPrompt,
          signAnswer: vi.fn(),
        }),
      },
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(1));
    await h.runtime.resend("item_p");
    const send = h.calls.find((c) => c.name === "send")!.input as {
      threadId: string;
      turnId: string;
      itemId: string;
      prompt: { text: string; signed: unknown };
    };
    expect(send).toMatchObject({
      threadId: "thr_1",
      prompt: { text: "add milk", agent: { hostId: "host_mac", agentId: "claude" } },
    });
    expect(send.turnId).not.toBe("turn_1");
    expect(send.itemId).not.toBe("item_p");
    expect(send.prompt.signed).toMatchObject({ at: 2 });
    expect(signPrompt).toHaveBeenCalledTimes(1);
  });

  it("reuses its ids when the resend is repeated after a failure, so the retry is a no-op", async () => {
    let failing = true;
    const h = setup({ open: async () => expired() });
    h.call.mockImplementation(async (name: string, input: unknown) => {
      h.calls.push({ name, input });
      if (name === "send" && failing) throw new ActionError("internal", "down");
      if (name === "open") return expired();
      return { id: "thr_1" };
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(1));
    await expect(h.runtime.resend("item_p")).rejects.toThrow();
    failing = false;
    await h.runtime.resend("item_p");
    const sends = h.calls.filter((c) => c.name === "send").map((c) => c.input) as {
      turnId: string;
      itemId: string;
    }[];
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });

  it("does nothing for a prompt it does not show", async () => {
    const h = setup({ open: async () => expired() });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().items).toHaveLength(1));
    await h.runtime.resend("nope");
    expect(h.names()).toEqual(["open"]);
  });
});

describe("createChatRuntime degradation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SECOND = 1000;
  const running = () =>
    snapshot({
      items: [logged(1, "item_p", "prompt", "go")],
      turns: [turn("turn_1", "running")],
    });
  const finished = () =>
    snapshot({
      items: [
        logged(1, "item_p", "prompt", "go"),
        logged(2, "turn_1.1", "reply", "Done"),
      ],
      turns: [turn("turn_1", "done")],
    });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const opens = (h: ReturnType<typeof setup>) => h.names().filter((n) => n === "open");

  function flaky(failures: number, then: () => ChatSnapshot) {
    const times: number[] = [];
    const t0 = Date.now();
    let failed = 0;
    return {
      times: () => times.map((at) => at - t0),
      open: async () => {
        times.push(Date.now());
        if (failed < failures) {
          failed += 1;
          throw new Error("offline");
        }
        return then();
      },
    };
  }

  it("T7-03 (a) retries a failed first open in the background, backing off to 30 s, until it shows the thread", async () => {
    const server = flaky(9, finished);
    const h = setup({ open: server.open });
    h.runtime.start();
    await settle();
    expect(h.runtime.get().status).toBe("unavailable");

    await vi.advanceTimersByTimeAsync(200 * SECOND);
    expect(server.times()).toEqual([
      0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000, 121_000, 151_000,
    ]);
    expect(h.runtime.get().status).toBe("idle");
    expect(h.shown().map((item) => item.id)).toEqual(["item_p", "turn_1.1"]);
    const reads = server.times().length;
    await vi.advanceTimersByTimeAsync(100 * SECOND);
    expect(server.times()).toHaveLength(reads);
  });

  it("T7-03 (b) retries a sync-triggered refresh that failed, with no further event, and shows the finished turn", async () => {
    let answer: () => ChatSnapshot = running;
    let broken = false;
    const h = setup({
      open: async () => {
        if (broken) throw new Error("offline");
        return answer();
      },
    });
    h.runtime.start();
    await settle();
    expect(h.runtime.get().status).toBe("running");

    broken = true;
    answer = finished;
    h.tags(["parlor_chat", "thr_1"]);
    await settle();
    expect(h.runtime.get().status).toBe("running");

    broken = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.runtime.get().status).toBe("idle");
    expect(h.shown().map((item) => item.id)).toEqual(["item_p", "turn_1.1"]);
    const reads = h.names().length;
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(h.names()).toHaveLength(reads);
  });

  it("T7-03 (b) folds sync events that arrive while a retry is pending into the same loop", async () => {
    let broken = false;
    const h = setup({
      open: async () => {
        if (broken) throw new Error("offline");
        return running();
      },
    });
    h.runtime.start();
    await settle();
    broken = true;
    h.tags(["parlor_chat", "thr_1"]);
    await settle();
    h.tags(["parlor_chat", "thr_1"]);
    await settle();
    const failedReads = opens(h).length;

    await vi.advanceTimersByTimeAsync(SECOND);
    expect(opens(h)).toHaveLength(failedReads + 1);
  });

  it.each(["sse", "poll"] as const)(
    "T7-03 (c) rereads once after the sync stream reconnects on %s, and shows the turn that finished meanwhile",
    async (transport) => {
      let answer: () => ChatSnapshot = running;
      const h = setup({ open: async () => answer(), transport });
      h.runtime.start();
      await settle();
      expect(h.runtime.get().status).toBe("running");
      const before = h.names().length;

      answer = finished;
      h.resume();
      if (transport === "sse") h.channel().opened();
      await settle();

      expect(h.names().slice(before)).toEqual(["open"]);
      expect(h.runtime.get().status).toBe("idle");
      expect(h.shown().map((item) => item.id)).toEqual(["item_p", "turn_1.1"]);
    },
  );

  it("T7-03 (c) rereads only what came after the last item on a resume with no turn running", async () => {
    const h = setup({
      open: async () =>
        snapshot({
          items: [logged(1, "item_p", "prompt", "go")],
          turns: [turn("turn_1", "done")],
        }),
      items: () => [logged(2, "turn_2.1", "reply", "late")],
    });
    h.runtime.start();
    await settle();
    h.resume();
    await settle();
    expect(h.calls.at(-1)).toEqual({
      name: "items",
      input: { threadId: "thr_1", afterSeq: 1 },
    });
  });

  it("T7-03 (d) does not retry a first open that fails with not_found, and ignores a resume", async () => {
    const h = setup({
      open: async () => {
        throw new ActionError("not_found", "Action request failed with HTTP 404");
      },
    });
    h.runtime.start();
    await settle();
    expect(h.runtime.get().status).toBe("unavailable");

    await vi.advanceTimersByTimeAsync(120 * SECOND);
    h.resume();
    await settle();
    expect(opens(h)).toHaveLength(1);
    expect(h.runtime.get().status).toBe("unavailable");
  });

  it.each(["unauthenticated", "forbidden"] as const)(
    "T7-03 (d) does not retry a first open refused as %s",
    async (code) => {
      const h = setup({
        open: async () => {
          throw new ActionError(code, "refused");
        },
      });
      h.runtime.start();
      await settle();
      await vi.advanceTimersByTimeAsync(120 * SECOND);
      expect(opens(h)).toHaveLength(1);
    },
  );

  it("T7-03 (d) runs no retry after the sidebar unmounts", async () => {
    const server = flaky(Number.POSITIVE_INFINITY, finished);
    const h = setup({ open: server.open });
    const stop = h.runtime.start();
    await settle();
    expect(server.times()).toHaveLength(1);

    stop();
    await vi.advanceTimersByTimeAsync(120 * SECOND);
    expect(server.times()).toHaveLength(1);
  });

  describe("a failed hosts or thread-list refresh", () => {
    const offlineMac = () => [claudeOnMac(false)];
    const queuedOnMac = () =>
      snapshot({
        items: [logged(1, "item_p", "prompt", "go")],
        turns: [turn("turn_1", "queued")],
      });

    function hostsServer() {
      const state = { broken: false, hosts: [claudeOnMac()] };
      const times: number[] = [];
      const t0 = Date.now();
      const h = setup({
        open: async () => ({ ...queuedOnMac(), hosts: state.hosts }),
        hosts: () => {
          times.push(Date.now() - t0);
          if (state.broken) throw new Error("offline");
          return state.hosts;
        },
      });
      return { h, state, times };
    }

    it("T7-03 (g) retries a failed hosts refresh with backoff and shows the host going offline", async () => {
      const { h, state, times } = hostsServer();
      h.runtime.start();
      await settle();
      expect(h.runtime.get().status).toBe("running");

      state.broken = true;
      state.hosts = offlineMac();
      h.tags(["parlor_chat_hosts"]);
      await settle();
      expect(h.runtime.get().status).toBe("running");

      await vi.advanceTimersByTimeAsync(3 * SECOND);
      expect(times).toEqual([0, SECOND, 3 * SECOND]);
      expect(h.runtime.get().status).toBe("running");

      state.broken = false;
      await vi.advanceTimersByTimeAsync(4 * SECOND);
      expect(h.runtime.get().status).toBe("waiting");
      expect(h.runtime.get().wait?.reason).toBe("offline");
      const reads = h.names().length;
      await vi.advanceTimersByTimeAsync(60 * SECOND);
      expect(h.names()).toHaveLength(reads);
    });

    it("T7-03 (g) retries a failed thread-list refresh until it lands", async () => {
      let broken = false;
      let listed = [thread("thr_1")];
      const h = setup({
        threadId: undefined,
        open: async () => {
          if (broken) throw new Error("offline");
          return { threads: listed, hosts: [claudeOnMac()], page: undefined } as never;
        },
      });
      h.runtime.start();
      await settle();
      h.runtime.newThread();
      await settle();

      broken = true;
      listed = [thread("thr_1"), thread("thr_2")];
      h.tags(["parlor_chat", "thr_2"]);
      await settle();
      expect(h.runtime.get().threads).toHaveLength(1);

      broken = false;
      await vi.advanceTimersByTimeAsync(SECOND);
      expect(h.runtime.get().threads).toHaveLength(2);
    });

    it("T7-03 (g) keeps retrying the hosts refresh after an items refresh succeeds", async () => {
      const state = { broken: false, hosts: [claudeOnMac()] };
      const times: number[] = [];
      const h = setup({
        open: async () => ({ ...snapshot(), hosts: state.hosts }),
        hosts: () => {
          times.push(Date.now());
          if (state.broken) throw new Error("offline");
          return state.hosts;
        },
      });
      h.runtime.start();
      await settle();

      state.broken = true;
      state.hosts = offlineMac();
      h.tags(["parlor_chat_hosts"]);
      await settle();
      h.tags(["parlor_chat", "thr_1"]);
      await settle();
      expect(h.names()).toContain("items");

      state.broken = false;
      await vi.advanceTimersByTimeAsync(SECOND);
      expect(times).toHaveLength(2);
      expect(h.runtime.get().hosts[0]?.online).toBe(false);
    });

    it("T7-03 (g) does not retry a hosts refresh refused as forbidden", async () => {
      let calls = 0;
      const h = setup({
        hosts: () => {
          calls += 1;
          throw new ActionError("forbidden", "no");
        },
      });
      h.runtime.start();
      await settle();
      h.tags(["parlor_chat_hosts"]);
      await vi.advanceTimersByTimeAsync(120 * SECOND);
      expect(calls).toBe(1);
    });

    it("T7-03 (g) runs no hosts retry after the sidebar unmounts", async () => {
      const { h, state, times } = hostsServer();
      const stop = h.runtime.start();
      await settle();
      state.broken = true;
      h.tags(["parlor_chat_hosts"]);
      await settle();
      const reads = times.length;
      stop();
      await vi.advanceTimersByTimeAsync(120 * SECOND);
      expect(times).toHaveLength(reads);
    });
  });

  it("T7-03 (d) runs no retry of a failed refresh after the sidebar unmounts", async () => {
    let broken = false;
    const h = setup({
      open: async () => {
        if (broken) throw new Error("offline");
        return running();
      },
    });
    const stop = h.runtime.start();
    await settle();
    broken = true;
    h.tags(["parlor_chat", "thr_1"]);
    await settle();
    const reads = opens(h).length;
    stop();
    await vi.advanceTimersByTimeAsync(120 * SECOND);
    expect(opens(h)).toHaveLength(reads);
  });
});

describe("createChatRuntime activity events", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("T7-05 (e) makes no read for an activity event, loaded or still loading", async () => {
    const loading = setup({ open: () => new Promise(() => undefined) });
    loading.runtime.start();
    loading.tags(["parlor_chat_activity"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(loading.names()).toEqual(["open"]);

    const loaded = setup();
    loaded.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = loaded.names().length;
    loaded.tags(["parlor_chat_activity"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(loaded.names()).toHaveLength(before);
    expect(loaded.names()).not.toContain("items");
  });

  const pings = (h: ReturnType<typeof setup>) =>
    h.names().filter((name) => name === "userActive").length;

  it("announces activity on a poll deployment when it starts, and at most once a minute after setDraft and send", async () => {
    const h = setup({ transport: "poll" });
    h.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(h)).toBe(1);

    h.runtime.setDraft("h");
    h.runtime.setDraft("hi");
    await vi.advanceTimersByTimeAsync(59_000);
    h.runtime.setDraft("hi!");
    expect(pings(h)).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    h.runtime.setDraft("hi!!");
    expect(pings(h)).toBe(2);

    await vi.advanceTimersByTimeAsync(61_000);
    await h.runtime.send("hi!!");
    expect(pings(h)).toBe(3);
  });

  it("never announces on an SSE deployment, while the tab is hidden, or before sync has negotiated", async () => {
    for (const options of [
      { transport: "sse" as const },
      { transport: "poll" as const, hidden: () => true },
      {},
    ]) {
      const h = setup(options);
      h.runtime.start();
      h.runtime.setDraft("hello");
      await vi.advanceTimersByTimeAsync(0);
      expect(pings(h)).toBe(0);
    }
  });

  it("T7-03 (f) pings as soon as sync negotiates poll after start and after the first read, at most once a minute", async () => {
    const h = setup();
    h.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(h)).toBe(0);

    h.negotiate("poll");
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(h)).toBe(1);

    h.negotiate("poll");
    await vi.advanceTimersByTimeAsync(59_000);
    h.negotiate("poll");
    expect(pings(h)).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    h.negotiate("poll");
    expect(pings(h)).toBe(2);
  });

  it("T7-03 (f) does not ping when sync negotiates SSE, while hidden, or after the sidebar unmounts", async () => {
    let hidden = false;
    const h = setup({ hidden: () => hidden });
    const stop = h.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    h.negotiate("sse");
    expect(pings(h)).toBe(0);

    hidden = true;
    h.negotiate("poll");
    expect(pings(h)).toBe(0);

    hidden = false;
    stop();
    h.negotiate("poll");
    expect(pings(h)).toBe(0);
  });

  it("swallows a server that has no userActive and stops asking", async () => {
    const h = setup({ transport: "poll" });
    const answer = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (name, input) => {
      if (name === "userActive") {
        h.calls.push({ name, input });
        throw new ActionError("not_found", "Action request failed with HTTP 404");
      }
      return answer(name, input);
    });
    h.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    h.runtime.setDraft("hello");
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(h)).toBe(1);
    expect(h.runtime.get().status).toBe("idle");
  });
});

describe("createChatRuntime waiting reasons", () => {
  const queued = (hostOnline: boolean, extra: Partial<ChatSnapshot["page"]> = {}) => ({
    threads: [thread("thr_1")],
    hosts: [claudeOnMac(hostOnline)],
    page: {
      thread: thread("thr_1"),
      items: [logged(1, "item_p", "prompt", "go")],
      open: [],
      turns: [turn("turn_1", "queued")],
      hasMore: false,
      ...extra,
    },
  });

  const read = async (snap: ChatSnapshot) => {
    const h = setup({ open: async () => snap });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).not.toBe("loading"));
    return h.runtime.get();
  };

  it("T7-01a derives waiting for a queued prompt whose computer is offline, naming it", async () => {
    const state = await read(queued(false));
    expect(state.status).toBe("waiting");
    expect(state.wait).toEqual({
      reason: "offline",
      hostId: "host_mac",
      hostName: "Alice's Mac",
    });
  });

  it("T7-01a keeps a prompt queued for an online computer running, with no wait", async () => {
    const state = await read(queued(true));
    expect(state.status).toBe("running");
    expect(state.wait).toBeUndefined();
  });

  it("T7-01a does not call a running turn waiting because its computer went offline", async () => {
    const state = await read(queued(false, { turns: [turn("turn_1", "running")] }));
    expect(state.status).toBe("running");
    expect(state.wait).toBeUndefined();
  });

  it("T7-01a names the approval over the offline wait when both hold", async () => {
    const pending: LoggedItem = {
      id: asId("item", "turn_1.1"),
      threadId: asId("thread", "thr_1"),
      turnId: asId("turn", "turn_1"),
      seq: 2,
      at: 2,
      author: "host",
      kind: "event",
      body: { event: "device_pending" },
    };
    const state = await read(
      queued(false, {
        items: [logged(1, "item_p", "prompt", "go"), pending],
      }),
    );
    expect(state.status).toBe("waiting");
    expect(state.wait).toMatchObject({ reason: "approval", hostName: "Alice's Mac" });
  });

  it("T7-01a derives the wait from the sync event that takes the computer offline", async () => {
    let online = true;
    const h = setup({
      open: async () => queued(online),
    });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    h.call.mockImplementation(async (name: string) =>
      name === "hosts" ? [claudeOnMac(false)] : undefined,
    );
    online = false;
    h.tags(["parlor_chat_hosts", "host_mac"]);
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("waiting"));
    expect(h.runtime.get().wait?.reason).toBe("offline");
  });
});
