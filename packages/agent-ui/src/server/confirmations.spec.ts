import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmationPrompt, ConfirmationsFrame } from "../protocol.js";
import { ConfirmationBoard, type ConfirmationRequest } from "./confirmations.js";
import { ClientDirectory } from "./directory.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

const TIMEOUT = 59_000;
const GRACE = 5_000;

function setup(options: { maxPendingPerScope?: number } = {}) {
  const directory = new ClientDirectory();
  let ids = 0;
  const board = new ConfirmationBoard({
    directory,
    timeoutMs: TIMEOUT,
    orphanGraceMs: GRACE,
    newId: () => `c${++ids}`,
    ...options,
  });
  const frames = new Map<string, ConfirmationsFrame[]>();
  const closers = new Map<string, () => void>();
  const connect = (clientId: string, scope = "default") => {
    closers.set(
      clientId,
      directory.connect({
        clientId,
        scope,
        send: (data) => {
          const frame = JSON.parse(data) as ConfirmationsFrame;
          frames.set(clientId, [...(frames.get(clientId) ?? []), frame]);
        },
      }),
    );
  };
  const join = (
    clientId: string,
    presence: { focused?: boolean; visible?: boolean; canConfirm?: boolean } = {},
    scope = "default",
  ) => {
    connect(clientId, scope);
    directory.presence(clientId, scope, {
      type: "presence",
      focused: presence.focused ?? true,
      visible: presence.visible ?? true,
      platform: "web",
      canConfirm: presence.canConfirm ?? true,
    });
  };
  const items = (clientId: string): readonly ConfirmationPrompt[] =>
    frames.get(clientId)?.at(-1)?.items ?? [];
  const framesTo = (clientId: string) => frames.get(clientId)?.length ?? 0;
  const request = (
    overrides: Partial<ConfirmationRequest> = {},
  ): ConfirmationRequest => ({
    scope: "default",
    action: "deleteTask",
    description: "Delete a task by id.",
    input: { id: "t1" },
    origin: { via: "mcp", name: "Claude Code" },
    ...overrides,
  });
  const answer = (clientId: string, id: string, approve: boolean, scope = "default") =>
    board.answer(clientId, scope, { type: "answer", id, approve });
  return {
    directory,
    board,
    join,
    items,
    framesTo,
    request,
    answer,
    leave: (clientId: string, scope = "default") => directory.leave(clientId, scope),
    drop: (clientId: string) => closers.get(clientId)?.(),
    present: (
      clientId: string,
      presence: Parameters<typeof join>[1],
      scope = "default",
    ) =>
      directory.presence(clientId, scope, {
        type: "presence",
        focused: presence?.focused ?? true,
        visible: presence?.visible ?? true,
        platform: "web",
        canConfirm: presence?.canConfirm ?? true,
      }),
  };
}

const outcome = (promise: Promise<unknown>) => {
  const state: { value?: unknown } = {};
  void promise.then((value) => {
    state.value = value;
  });
  return state;
};

describe("ConfirmationBoard approval", () => {
  it("shows the card to the client the user is looking at and resolves approved on their answer", async () => {
    const { board, join, items, request, answer } = setup();
    join("a");
    join("b", { focused: false, visible: false });
    const settled = outcome(board.ask(request()));
    expect(items("a")).toEqual([
      {
        id: "c1",
        action: "deleteTask",
        description: "Delete a task by id.",
        input: { id: "t1" },
        origin: { via: "mcp", name: "Claude Code" },
        expiresInMs: TIMEOUT,
      },
    ]);
    expect(items("b")).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(answer("a", "c1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
    expect(items("a")).toEqual([]);
  });

  it("counts the remaining wait into each frame it sends", () => {
    const { board, join, items, request } = setup();
    join("a", { focused: false });
    void board.ask(request());
    vi.advanceTimersByTime(20_000);
    join("b");
    expect(items("b")[0]?.expiresInMs).toBe(39_000);
  });

  it("resolves declined when the user declines", async () => {
    const { board, join, request, answer } = setup();
    join("a");
    const settled = outcome(board.ask(request()));
    answer("a", "c1", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("declined");
  });

  it("is settled once: a second answer, even from the audience, is refused", async () => {
    const { board, join, request, answer } = setup();
    join("a");
    const settled = outcome(board.ask(request()));
    expect(answer("a", "c1", true)).toBe(true);
    expect(answer("a", "c1", false)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
  });

  it("keeps several pending confirmations apart, in the order they were asked", async () => {
    const { board, join, items, request, answer } = setup();
    join("a");
    const first = outcome(board.ask(request({ input: { id: "one" } })));
    const second = outcome(board.ask(request({ input: { id: "two" } })));
    expect(items("a").map((i) => i.input)).toEqual([{ id: "one" }, { id: "two" }]);
    answer("a", "c2", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(items("a").map((i) => i.id)).toEqual(["c1"]);
    expect(second.value).toBe("declined");
    expect(first.value).toBeUndefined();
  });

  it("targets the client named in the request instead of selecting one", () => {
    const { board, join, items, request } = setup();
    join("a");
    join("b", { focused: false, visible: false });
    void board.ask(request({ clientId: "b" }));
    expect(items("b")).toHaveLength(1);
    expect(items("a")).toEqual([]);
  });

  it("survives an input that is not JSON", () => {
    const { board, join, items, request } = setup();
    join("a");
    const cyclic: Record<string, unknown> = { big: 10n };
    cyclic.self = cyclic;
    void board.ask(request({ input: cyclic }));
    expect(items("a")).toHaveLength(1);
  });
});

describe("ConfirmationBoard audience", () => {
  it("shows the card on every tied client and dismisses it everywhere once one answers", async () => {
    const { board, join, items, request, answer } = setup();
    join("a");
    join("b");
    const settled = outcome(board.ask(request()));
    expect(items("a")).toHaveLength(1);
    expect(items("b")).toHaveLength(1);
    expect(answer("b", "c1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
    expect(items("a")).toEqual([]);
    expect(items("b")).toEqual([]);
    expect(answer("a", "c1", true)).toBe(false);
  });

  it("never asks a client that cannot draw a card, and refuses its answer", async () => {
    const { board, join, items, request, answer } = setup();
    join("a", { canConfirm: false });
    join("b", { focused: false, visible: false });
    const settled = outcome(board.ask(request()));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("unavailable");
    expect(items("a")).toEqual([]);
    expect(answer("a", "c1", true)).toBe(false);
  });

  it("refuses an answer from a client that was never in the audience, leaving the wait open", async () => {
    const { board, join, request, answer } = setup();
    join("a");
    join("b", { focused: false, visible: false });
    const settled = outcome(board.ask(request()));
    expect(answer("b", "c1", true)).toBe(false);
    expect(answer("a", "nope", true)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBeUndefined();
    expect(answer("a", "c1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
  });

  it("refuses an answer from another scope", () => {
    const { board, join, request, answer } = setup();
    join("a");
    join("z", { focused: true }, "other");
    void board.ask(request());
    expect(answer("z", "c1", true, "other")).toBe(false);
    expect(answer("a", "c1", true, "other")).toBe(false);
    expect(answer("a", "c1", true)).toBe(true);
  });

  it("keeps a scope's cards to that scope", () => {
    const { board, join, items, request } = setup();
    join("a");
    join("z", { focused: true }, "other");
    void board.ask(request());
    expect(items("a")).toHaveLength(1);
    expect(items("z")).toEqual([]);
  });

  it("adds the client the user moves to and leaves the card where it was", async () => {
    const { board, join, items, request, present, answer } = setup();
    join("a");
    join("b", { focused: false, visible: false });
    const settled = outcome(board.ask(request()));
    present("a", { focused: false, visible: true });
    present("b", { focused: true, visible: true });
    expect(items("b")).toHaveLength(1);
    expect(items("a")).toHaveLength(1);
    expect(answer("b", "c1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
  });
});

describe("ConfirmationBoard without anyone to ask", () => {
  it("answers unavailable at once when no app is open", async () => {
    const { board, request } = setup();
    const settled = outcome(board.ask(request()));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a reload's gap: the card moves to the new client and the wait goes on", async () => {
    const { board, join, items, request, leave, answer } = setup();
    join("old");
    const settled = outcome(board.ask(request()));
    leave("old");
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(settled.value).toBeUndefined();
    join("new");
    expect(items("new").map((i) => i.id)).toEqual(["c1"]);
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(settled.value).toBeUndefined();
    expect(answer("new", "c1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
  });

  it("treats a dropped connection like a client that left", async () => {
    const { board, join, request, drop } = setup();
    join("a");
    const settled = outcome(board.ask(request()));
    drop("a");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(settled.value).toBe("unavailable");
  });

  it("gives up with unavailable once the grace is over", async () => {
    const { board, join, request, leave } = setup();
    join("a");
    const settled = outcome(board.ask(request()));
    leave("a");
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(settled.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled.value).toBe("unavailable");
  });

  it("starts the grace over each time the last client goes and a client comes back", async () => {
    const { board, join, request, leave } = setup();
    join("a");
    const settled = outcome(board.ask(request()));
    leave("a");
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    join("b");
    leave("b");
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(settled.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled.value).toBe("unavailable");
  });

  it("refuses once too many confirmations wait in one scope", async () => {
    const { board, join, request } = setup({ maxPendingPerScope: 2 });
    join("a");
    void board.ask(request());
    void board.ask(request());
    const third = outcome(board.ask(request()));
    await vi.advanceTimersByTimeAsync(0);
    expect(third.value).toBe("unavailable");
  });
});

describe("ConfirmationBoard deadline and cancellation", () => {
  it("resolves timeout at the deadline and clears every card", async () => {
    const { board, join, items, request } = setup();
    join("a");
    join("b");
    const settled = outcome(board.ask(request()));
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(settled.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled.value).toBe("timeout");
    expect(items("a")).toEqual([]);
    expect(items("b")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves cancelled when the agent aborts, and clears the cards", async () => {
    const { board, join, items, request } = setup();
    join("a");
    const controller = new AbortController();
    const settled = outcome(board.ask(request({ signal: controller.signal })));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("cancelled");
    expect(items("a")).toEqual([]);
  });

  it("resolves cancelled at once for a signal that is already aborted", async () => {
    const { board, join, items, request } = setup();
    join("a");
    const settled = outcome(board.ask(request({ signal: AbortSignal.abort() })));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("cancelled");
    expect(items("a")).toEqual([]);
  });

  it("ends every pending confirmation with shutdown when the server closes", async () => {
    const { board, join, request } = setup();
    join("a");
    const one = outcome(board.ask(request()));
    const two = outcome(board.ask(request()));
    board.close();
    await vi.advanceTimersByTimeAsync(0);
    expect([one.value, two.value]).toEqual(["shutdown", "shutdown"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers shutdown at once to a confirmation asked after the server closed", async () => {
    const { board, join, items, request } = setup();
    join("a");
    board.close();
    const settled = outcome(board.ask(request()));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("shutdown");
    expect(items("a")).toEqual([]);
  });
});

describe("ConfirmationBoard frames", () => {
  it("sends a client only changes: not on touches, repeated presence, or other scopes' activity", () => {
    const { board, directory, join, framesTo, request, present } = setup();
    join("a");
    void board.ask(request());
    const sent = framesTo("a");
    expect(sent).toBeGreaterThan(0);
    directory.touch("a", "default");
    present("a", { focused: true });
    present("a", { focused: true });
    expect(framesTo("a")).toBe(sent);
  });

  it("sends nothing to a client while nothing is pending, so the action hot path stays quiet", () => {
    const { board, directory, join, framesTo, request } = setup();
    join("a");
    directory.touch("a", "default");
    expect(framesTo("a")).toBe(0);
    void board.ask(request());
    expect(framesTo("a")).toBe(1);
  });

  it("sends the whole list again to a client that re-registers after a reconnect, even an empty one", async () => {
    const { board, join, items, framesTo, request, drop, answer } = setup();
    join("a");
    join("b");
    const settled = outcome(board.ask(request()));
    drop("a");
    answer("b", "c1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.value).toBe("approved");
    const before = framesTo("a");
    join("a");
    expect(framesTo("a")).toBe(before + 1);
    expect(items("a")).toEqual([]);
  });

  it("still clears the stale card of a client that comes back before its card could have expired", async () => {
    const { board, join, items, framesTo, request, drop } = setup();
    join("a");
    void board.ask(request());
    drop("a");
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    const before = framesTo("a");
    join("a");
    expect(framesTo("a")).toBe(before + 1);
    expect(items("a")).toEqual([]);
  });

  it("stops remembering a client that left with a card once that card must have expired on its screen", async () => {
    const { board, join, framesTo, request, drop } = setup();
    join("a");
    void board.ask(request());
    drop("a");
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    const before = framesTo("a");
    expect(before).toBe(1);
    join("a");
    expect(framesTo("a")).toBe(before);
  });

  it("counts that wait from the client's latest leave", async () => {
    const { board, join, items, framesTo, request, drop } = setup();
    join("a");
    void board.ask(request());
    drop("a");
    await vi.advanceTimersByTimeAsync(1000);
    join("a");
    drop("a");
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    const before = framesTo("a");
    join("a");
    expect(framesTo("a")).toBe(before + 1);
    expect(items("a")).toEqual([]);
  });

  it("resends a pending list to a client that re-registers", () => {
    const { board, join, items, framesTo, request, drop } = setup();
    join("a");
    void board.ask(request());
    const before = framesTo("a");
    drop("a");
    join("a");
    expect(framesTo("a")).toBeGreaterThan(before);
    expect(items("a")).toHaveLength(1);
  });
});

describe("ConfirmationBoard thread-bound cards", () => {
  const thread = { threadId: "thr_alice", turnId: "turn_1" };

  function tabs() {
    const harness = setup();
    const { directory } = harness;
    const join = (
      clientId: string,
      scope: string,
      watching: string[],
      canConfirm = true,
    ) => {
      harness.join(clientId, { canConfirm }, scope);
      directory.presence(clientId, scope, {
        type: "presence",
        focused: true,
        visible: true,
        platform: "web",
        canConfirm,
        watching,
      });
    };
    return { ...harness, join };
  }

  it("reaches both of the owner's tabs on the thread and never another user's tab", () => {
    const { board, join, items, request } = tabs();
    join("alice-1", "alice", ["thr_alice"]);
    join("alice-2", "alice", ["thr_alice"]);
    join("alice-3", "alice", ["thr_other"]);
    join("bob-1", "bob", ["thr_alice"]);
    void board.ask(request({ scope: "alice", clientId: "alice-1", thread }));

    expect(items("alice-1").map((i) => [i.id, i.threadId])).toEqual([
      ["c1", "thr_alice"],
    ]);
    expect(items("alice-2").map((i) => [i.id, i.threadId])).toEqual([
      ["c1", "thr_alice"],
    ]);
    expect(items("alice-3")).toEqual([]);
    expect(items("bob-1")).toEqual([]);
  });

  it("reaches the tab that sent the prompt even when it is not watching, but not when it cannot confirm", () => {
    const { board, join, items, request } = tabs();
    join("sender", "alice", []);
    join("mute", "alice", ["thr_alice"], false);
    void board.ask(request({ scope: "alice", clientId: "sender", thread }));
    expect(items("sender").map((i) => i.id)).toEqual(["c1"]);
    expect(items("mute")).toEqual([]);
  });

  it("is answerable from the second tab, and the first tab's card leaves", async () => {
    const { board, join, items, request, answer } = tabs();
    join("alice-1", "alice", ["thr_alice"]);
    join("alice-2", "alice", ["thr_alice"]);
    const settled = board.ask(request({ scope: "alice", clientId: "alice-1", thread }));
    expect(answer("alice-2", "c1", true, "alice")).toBe(true);
    await expect(settled).resolves.toBe("approved");
    expect(items("alice-1")).toEqual([]);
    expect(items("alice-2")).toEqual([]);
  });

  it("refuses an answer from another user's tab", () => {
    const { board, join, request, answer } = tabs();
    join("alice-1", "alice", ["thr_alice"]);
    join("bob-1", "bob", ["thr_alice"]);
    void board.ask(request({ scope: "alice", clientId: "alice-1", thread }));
    expect(answer("bob-1", "c1", true, "bob")).toBe(false);
  });

  it("follows the thread as tabs start and stop watching it", () => {
    const { board, join, directory, items, request } = tabs();
    join("alice-1", "alice", ["thr_alice"]);
    join("alice-2", "alice", []);
    void board.ask(request({ scope: "alice", clientId: "alice-1", thread }));
    expect(items("alice-2")).toEqual([]);

    directory.presence("alice-2", "alice", {
      type: "presence",
      focused: true,
      visible: true,
      platform: "web",
      canConfirm: true,
      watching: ["thr_alice"],
    });
    expect(items("alice-2").map((i) => i.id)).toEqual(["c1"]);

    directory.presence("alice-2", "alice", {
      type: "presence",
      focused: true,
      visible: true,
      platform: "web",
      canConfirm: true,
    });
    expect(items("alice-2")).toEqual([]);
    expect(items("alice-1").map((i) => i.id)).toEqual(["c1"]);
  });

  it("is unavailable when nobody can show it", async () => {
    const { board, join, request } = tabs();
    join("alice-1", "alice", ["thr_alice"], false);
    await expect(
      board.ask(request({ scope: "alice", clientId: "alice-1", thread })),
    ).resolves.toBe("unavailable");
  });

  it("leaves an external agent's card on the presence selection, without a thread id", () => {
    const { board, join, items, request } = tabs();
    join("alice-1", "alice", ["thr_alice"]);
    void board.ask(request({ scope: "alice" }));
    expect(items("alice-1")).toEqual([
      {
        id: "c1",
        action: "deleteTask",
        description: "Delete a task by id.",
        input: { id: "t1" },
        origin: { via: "mcp", name: "Claude Code" },
        expiresInMs: TIMEOUT,
      },
    ]);
  });
});
