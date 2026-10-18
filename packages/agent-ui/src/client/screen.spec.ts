import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ScreenSnapshot } from "../protocol.js";
import { defineAgentView } from "../view.js";
import { fakeBrowser } from "./fake-browser.testing.js";
import { createViewRegistry } from "./registry.js";
import { captureScreen, DEFAULT_SCREEN_LIMITS, type ScreenLimits } from "./screen.js";

const task = defineAgentView({
  name: "task",
  description: "A task row.",
  keyed: true,
  schema: z.object({ title: z.string(), done: z.boolean() }),
});

const draft = defineAgentView({
  name: "draft",
  description: "The draft being written.",
  schema: z.object({ text: z.string() }),
});

const ROW = 30;

function setup(count: number) {
  const browser = fakeBrowser();
  const registry = createViewRegistry(browser.env);
  const list = browser.document.createElement("ul");
  browser.document.body.appendChild(list);
  const gets = vi.fn();
  const rows = Array.from({ length: count }, (_, i) => {
    const element = browser.document.createElement("li");
    element.textContent = `Task ${i + 1}`;
    list.appendChild(element);
    const key = `t${i + 1}`;
    const slot = registry.track(task, {
      key,
      get: () => {
        gets(key);
        return { title: `Task ${i + 1}`, done: false };
      },
    });
    slot.ref(element);
    const unmount = slot.mount(key);
    return { element, key, slot, unmount };
  });
  const scrollTo = (firstTop: number) => {
    rows.forEach((row, i) => {
      browser.setRect(row.element, firstTop + i * ROW, ROW);
      const top = firstTop + i * ROW;
      browser.intersect(row.element, top < 600 && top + ROW > 0);
    });
  };
  const capture = (limits: Partial<ScreenLimits> = {}): ScreenSnapshot =>
    captureScreen(
      registry,
      {
        route: () => null,
        queries: () => [{ action: "listTasks", input: {}, status: "success" }],
      },
      browser.env,
      { ...DEFAULT_SCREEN_LIMITS, ...limits },
    );
  return { browser, registry, rows, gets, scrollTo, capture };
}

const keyedItems = (snapshot: ScreenSnapshot, name = "task") =>
  (snapshot.views[name] as { items: { key: string; shown: number }[] }).items;

describe("captureScreen keyed views", () => {
  it("lists only on-screen items in document order with their shown ratio and an offscreen count", () => {
    const { scrollTo, capture, gets, rows } = setup(1000);
    scrollTo(-15 - ROW * 100);
    const snapshot = capture();
    const items = keyedItems(snapshot);
    expect(items.map((i) => i.key)).toEqual(
      Array.from({ length: 21 }, (_, i) => `t${101 + i}`),
    );
    expect(items[0]).toEqual({
      key: "t101",
      value: { title: "Task 101", done: false },
      shown: 0.5,
    });
    expect(items.at(-1)?.shown).toBe(0.5);
    expect(items[1]?.shown).toBe(1);
    expect(snapshot.views.task).toMatchObject({ offscreen: 979 });
    expect(gets).toHaveBeenCalledTimes(21);
    expect(rows).toHaveLength(1000);
  });

  it("measures elements the observer has not reported yet, as in a hidden tab", () => {
    const { browser, rows, capture } = setup(40);
    rows.forEach((row, i) => browser.setRect(row.element, i * ROW, ROW));
    expect(keyedItems(capture()).map((i) => i.key)).toEqual(
      Array.from({ length: 20 }, (_, i) => `t${i + 1}`),
    );
  });

  it("caps each keyed view at the item limit and counts the rest as offscreen", () => {
    const { scrollTo, capture } = setup(80);
    scrollTo(0);
    const snapshot = capture({ itemsPerView: 5 });
    expect(keyedItems(snapshot).map((i) => i.key)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
    expect(snapshot.views.task).toMatchObject({ offscreen: 75 });
  });

  it("picks the on-screen item closest to the viewport centre as focal", () => {
    const { scrollTo, capture } = setup(30);
    scrollTo(300 - 14 * ROW - ROW / 2);
    expect(capture().attention.focal).toEqual({ view: "task", key: "t15" });
  });

  it("forgets unmounted items and stacks duplicate identities with the newest winning", () => {
    const { browser, registry, rows, scrollTo, capture } = setup(3);
    scrollTo(0);
    rows[1]!.unmount();
    expect(keyedItems(capture()).map((i) => i.key)).toEqual(["t1", "t3"]);

    const replacement = browser.document.createElement("li");
    browser.document.body.appendChild(replacement);
    browser.setRect(replacement, 400, ROW);
    const slot = registry.track(task, {
      key: "t1",
      get: () => ({ title: "Task 1 (new page)", done: true }),
    });
    slot.ref(replacement);
    const unmountNew = slot.mount("t1");
    browser.intersect(replacement, true);
    const items = (capture().views.task as { items: { key: string; value: unknown }[] })
      .items;
    expect(items.filter((i) => i.key === "t1")).toEqual([
      { key: "t1", value: { title: "Task 1 (new page)", done: true }, shown: 1 },
    ]);
    unmountNew();
    expect(keyedItems(capture()).find((i) => i.key === "t1")).toMatchObject({ shown: 1 });
  });

  it("survives StrictMode's mount, unmount, mount without duplicates", () => {
    const { rows, scrollTo, capture } = setup(2);
    rows[0]!.unmount();
    const again = rows[0]!.slot.mount("t1");
    scrollTo(0);
    expect(keyedItems(capture()).map((i) => i.key)).toEqual(["t1", "t2"]);
    again();
    expect(keyedItems(capture()).map((i) => i.key)).toEqual(["t2"]);
  });
});

describe("captureScreen single views and budgets", () => {
  function withDraft(text: string, limits: Partial<ScreenLimits> = {}) {
    const { browser, registry, capture, scrollTo } = setup(40);
    const form = browser.document.createElement("form");
    browser.document.body.appendChild(form);
    browser.setRect(form, 100, 200);
    const slot = registry.track(draft, { get: () => ({ text }) });
    slot.ref(form);
    slot.mount(undefined);
    scrollTo(-15);
    return { snapshot: capture(limits), browser };
  }

  it("reports a single view's value and how much of it is shown", () => {
    const { snapshot } = withDraft("hello");
    expect(snapshot.views.draft).toEqual({ value: { text: "hello" }, shown: 1 });
    expect(snapshot.queries).toEqual([
      { action: "listTasks", input: {}, status: "success" },
    ]);
    expect(snapshot.truncated).toBe(false);
  });

  it("replaces a value over the per-value limit with its size", () => {
    const { snapshot } = withDraft("x".repeat(100), { valueBytes: 50 });
    expect(snapshot.views.draft).toEqual({
      value: { truncated: true, bytes: 111 },
      shown: 1,
    });
  });

  it("drops the least shown items, then queries, to fit the total budget", () => {
    const { snapshot } = withDraft("hello", { totalBytes: 900 });
    const json = JSON.stringify(snapshot);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(900);
    expect(snapshot.truncated).toBe(true);
    const items = keyedItems(snapshot);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(20);
    expect(items.every((i) => i.shown === 1)).toBe(true);
  });

  it("always fits the default budget with a thousand long items", () => {
    const { browser, registry } = setup(0);
    const list = browser.document.createElement("ul");
    browser.document.body.appendChild(list);
    for (let i = 0; i < 1000; i++) {
      const element = browser.document.createElement("li");
      list.appendChild(element);
      browser.setRect(element, i * 10, 10);
      const slot = registry.track(task, {
        key: `k${i}`,
        get: () => ({ title: "y".repeat(3000), done: false }),
      });
      slot.ref(element);
      slot.mount(`k${i}`);
    }
    const snapshot = captureScreen(
      registry,
      { route: () => null, queries: () => [] },
      browser.env,
      DEFAULT_SCREEN_LIMITS,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.truncated).toBe(true);
  });
});

describe("captureScreen attention", () => {
  it("reports focus with the field name and label, the selection, and recent interaction", () => {
    const { browser, registry, rows, scrollTo, capture } = setup(5);
    scrollTo(0);
    const form = browser.document.createElement("form");
    form.innerHTML = '<label for="to">Recipient</label><input id="to" name="to">';
    browser.document.body.appendChild(form);
    const slot = registry.track(draft, { get: () => ({ text: "" }) });
    slot.ref(form);
    slot.mount(undefined);

    browser.tick(100);
    rows[2]!.element.dispatchEvent(
      new browser.window.Event("pointerdown", { bubbles: true }),
    );
    browser.tick(400);
    const input = form.querySelector("input")!;
    input.focus();
    const range = browser.document.createRange();
    range.selectNodeContents(rows[3]!.element);
    browser.document.getSelection()!.removeAllRanges();
    browser.document.getSelection()!.addRange(range);
    browser.tick(50);

    const attention = capture({ selectionChars: 4 }).attention;
    expect(attention.focus).toEqual({ view: "draft", field: "to", label: "Recipient" });
    expect(attention.selection).toEqual({
      text: "Task",
      within: { view: "task", key: "t4" },
      truncated: true,
    });
    expect(attention.lastInteracted).toEqual({ view: "draft", agoMs: 50 });
  });

  it("reports no selection unless it lies inside one declared view", () => {
    const { browser, rows, capture } = setup(3);
    const outside = browser.document.createElement("h1");
    outside.textContent = "Hello, world!";
    browser.document.body.prepend(outside);
    const select = (start: Node, end: Node) => {
      const range = browser.document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.childNodes.length);
      browser.document.getSelection()!.removeAllRanges();
      browser.document.getSelection()!.addRange(range);
    };

    select(outside, outside);
    expect(capture().attention.selection).toBeNull();
    select(outside, rows[0]!.element);
    expect(capture().attention.selection).toBeNull();
    select(rows[0]!.element, rows[1]!.element);
    expect(capture().attention.selection).toBeNull();
    select(rows[1]!.element, rows[1]!.element);
    expect(capture().attention.selection).toEqual({
      text: "Task 2",
      within: { view: "task", key: "t2" },
      truncated: false,
    });
  });

  it("remembers the item that most recently scrolled into view", () => {
    const { browser, rows, capture } = setup(5);
    browser.intersect(rows[0]!.element, false);
    browser.intersect(rows[4]!.element, false);
    browser.intersect(rows[0]!.element, true);
    browser.tick(10);
    browser.intersect(rows[4]!.element, true);
    browser.tick(30);
    expect(capture().attention.lastEntered).toEqual({
      view: "task",
      key: "t5",
      agoMs: 30,
    });
  });

  it("does not count items already on screen when they mount as entered", () => {
    const { scrollTo, capture } = setup(30);
    scrollTo(0);
    expect(capture().attention.lastEntered).toBeNull();
    scrollTo(-ROW * 3);
    expect(capture().attention.lastEntered).toEqual({
      view: "task",
      key: "t23",
      agoMs: 0,
    });
  });

  it("does not count an item visible on its first observation after a remount as entered", () => {
    const { browser, rows, scrollTo, capture } = setup(2);
    scrollTo(0);
    rows[0]!.unmount();
    rows[0]!.slot.mount("t1");
    browser.intersect(rows[0]!.element, true);
    expect(capture().attention.lastEntered).toBeNull();
  });

  it("reports nothing when no element has focus or selection", () => {
    const { capture } = setup(1);
    expect(capture().attention).toMatchObject({
      focus: null,
      selection: null,
      lastInteracted: null,
    });
  });
});
