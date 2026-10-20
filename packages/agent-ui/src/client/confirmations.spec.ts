import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmationPrompt } from "../protocol.js";
import { createConfirmationStore } from "./confirmations.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000);
});
afterEach(() => vi.useRealTimers());

const prompt = (id: string, expiresInMs = 59_000): ConfirmationPrompt => ({
  id,
  action: "deleteTask",
  description: "Delete a task.",
  input: { id: `task-${id}` },
  origin: { via: "mcp", name: "Claude Code" },
  expiresInMs,
});

function setup() {
  const answers: [string, boolean][] = [];
  const onWatchedChange = vi.fn();
  const onChange = vi.fn();
  const store = createConfirmationStore({
    env: {
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
    answer: (id, approve) => answers.push([id, approve]),
    onWatchedChange,
    onChange,
  });
  return { store, answers, onWatchedChange, onChange };
}

const ids = (store: ReturnType<typeof setup>["store"]) => store.get().map((c) => c.id);

describe("createConfirmationStore", () => {
  it("starts empty and turns a frame's prompts into items with a local deadline", () => {
    const { store } = setup();
    expect(store.get()).toEqual([]);
    store.replace([prompt("c1", 40_000)]);
    expect(store.get()).toEqual([
      {
        id: "c1",
        action: "deleteTask",
        description: "Delete a task.",
        input: { id: "task-c1" },
        origin: { via: "mcp", name: "Claude Code" },
        expiresAt: 45_000,
        approve: expect.any(Function),
        decline: expect.any(Function),
      },
    ]);
  });

  it("keeps the same list and item objects while the server's list has not changed, and does not notify", () => {
    const { store, onChange } = setup();
    store.replace([prompt("c1")]);
    const list = store.get();
    expect(ids(store)).toEqual(["c1"]);
    const item = list[0];
    onChange.mockClear();
    vi.advanceTimersByTime(1000);
    store.replace([prompt("c1", 58_000)]);
    expect(store.get()).toBe(list);
    expect(store.get()[0]).toBe(item);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows the server's list: new items appear in order, missing ones disappear", () => {
    const { store, onChange } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.replace([prompt("c1"), prompt("c2")]);
    store.replace([prompt("c2"), prompt("c3")]);
    expect(ids(store)).toEqual(["c2", "c3"]);
    store.replace([]);
    expect(store.get()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("sends the answer once and hides the item at once, without waiting for the server", () => {
    const { store, answers } = setup();
    store.replace([prompt("c1"), prompt("c2")]);
    const [first] = store.get();
    first!.approve();
    first!.decline();
    expect(answers).toEqual([["c1", true]]);
    expect(ids(store)).toEqual(["c2"]);
    store.replace([prompt("c1"), prompt("c2")]);
    expect(ids(store)).toEqual(["c2"]);
    store.get()[0]!.decline();
    expect(answers).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
  });

  it("forgets an answered id once the server stops listing it, so a reused id shows again", () => {
    const { store } = setup();
    store.replace([prompt("c1")]);
    store.get()[0]!.approve();
    store.replace([]);
    store.replace([prompt("c1")]);
    expect(ids(store)).toEqual(["c1"]);
  });

  it("drops an item at its deadline even if the server's frame never comes", () => {
    const { store, onChange } = setup();
    store.replace([prompt("c1", 10_000), prompt("c2", 20_000)]);
    onChange.mockClear();
    vi.advanceTimersByTime(9_999);
    expect(ids(store)).toEqual(["c1", "c2"]);
    vi.advanceTimersByTime(1);
    expect(ids(store)).toEqual(["c2"]);
    vi.advanceTimersByTime(10_000);
    expect(store.get()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is watched while something subscribes, and says so when that flips", () => {
    const { store, onWatchedChange } = setup();
    expect(store.watched()).toBe(false);
    const off1 = store.subscribe(() => {});
    const off2 = store.subscribe(() => {});
    expect(store.watched()).toBe(true);
    expect(onWatchedChange).toHaveBeenCalledTimes(1);
    off1();
    expect(onWatchedChange).toHaveBeenCalledTimes(1);
    off2();
    expect(store.watched()).toBe(false);
    expect(onWatchedChange).toHaveBeenCalledTimes(2);
  });

  it("stops timers on dispose", () => {
    const { store } = setup();
    store.replace([prompt("c1")]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createConfirmationStore thread ids", () => {
  it("exposes the thread of a card an inline agent raised, and none on an external agent's", () => {
    const { store } = setup();
    store.replace([{ ...prompt("c1"), threadId: "thr_1" }, prompt("c2")]);
    expect(store.get().map((c) => [c.id, c.threadId])).toEqual([
      ["c1", "thr_1"],
      ["c2", undefined],
    ]);
  });

  it("treats the same card moving to another thread as a new card", () => {
    const { store } = setup();
    store.replace([{ ...prompt("c1"), threadId: "thr_1" }]);
    const first = store.get()[0];
    store.replace([{ ...prompt("c1"), threadId: "thr_2" }]);
    expect(store.get()[0]).not.toBe(first);
    expect(store.get()[0]?.threadId).toBe("thr_2");
  });
});
