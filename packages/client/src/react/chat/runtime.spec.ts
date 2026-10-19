import type { AgentConfirmation, AgentUiClient } from "@parlor/agent-ui/client";
import type { CapabilityHandle, LocalAgentHost } from "@parlor/capabilities";
import type {
  ChatSnapshot,
  HostSummary,
  LoggedItem,
  ThreadSummary,
  TurnStatus,
} from "@parlor/chat";
import { ActionError, asId, type Tag } from "@parlor/core";
import type { ClientChannel } from "@parlor/sync";
import { describe, expect, it, vi } from "vitest";

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
    open?: () => Promise<ChatSnapshot>;
    items?: (afterSeq: number) => LoggedItem[];
    threadId?: string;
    localHost?: CapabilityHandle<LocalAgentHost>;
    auth?: Partial<DeviceSource & HostAuthorizer>;
  } = {},
) {
  const calls: { name: string; input: unknown }[] = [];
  const handlers: Record<string, (input: never) => unknown> = {
    open: options.open ?? (async () => snapshot()),
    items: (input: { afterSeq: number }) => options.items?.(input.afterSeq) ?? [],
    hosts: () => [claudeOnMac()],
    send: (input: { threadId: string }) => ({ id: input.threadId, turnId: "t" }),
    cancel: (input: { threadId: string }) => ({ id: input.threadId }),
    answer: (input: { threadId: string }) => ({ id: input.threadId }),
  };
  const call = vi.fn(async (name: string, input: unknown) => {
    calls.push({ name, input });
    return handlers[name]!(input as never);
  });
  let channel: ClientChannel | undefined;
  const detachChannel = vi.fn();
  const tagListeners = new Set<(tags: readonly Tag[]) => void>();
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
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("idle"));
    h.frame(delta(0, "Hel"));
    expect(h.shown().filter((item) => item.id === "turn_1.1")).toEqual([
      { id: "turn_1.1", text: "Hello", streaming: false },
    ]);
  });

  it("ignores frames of another thread", async () => {
    const h = setup({ open: async () => reloaded() });
    h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.get().status).toBe("running"));
    h.frame({ ...delta(3, "lo"), threadId: "thr_other" });
    expect(h.shown().at(-1)?.text).toBe("Hel");
  });
});

describe("createChatRuntime poll deployments", () => {
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
});
