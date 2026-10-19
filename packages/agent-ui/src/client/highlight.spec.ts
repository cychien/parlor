// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAgentView } from "../view.js";
import { fakeBrowser } from "./fake-browser.testing.js";
import { createHighlightMarks, HIGHLIGHT_ATTRIBUTE, highlightView } from "./highlight.js";
import { createViewRegistry } from "./registry.js";
import { setView } from "./write.js";

const form = defineAgentView({
  name: "form",
  description: "A form.",
  schema: z.object({ title: z.string(), notes: z.string() }),
  writable: ["title", "notes"],
});
const row = defineAgentView({
  name: "row",
  description: "A row.",
  keyed: true,
  schema: z.object({ title: z.string(), notes: z.string() }),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

function setup() {
  const browser = fakeBrowser();
  const registry = createViewRegistry(browser.env);
  const marks = createHighlightMarks(browser.env);
  const mount = (view: Parameters<typeof registry.track>[0], key?: string) => {
    const element = browser.document.createElement("form");
    const title = browser.document.createElement("input");
    title.name = "title";
    const notes = browser.document.createElement("input");
    notes.name = "notes";
    element.append(title, notes);
    browser.document.body.appendChild(element);
    browser.setRect(element, 300, 100);
    const state = { value: { title: "", notes: "" } };
    const slot = registry.track(view, {
      ...(key === undefined ? {} : { key }),
      get: () => state.value,
      set: (next) => {
        state.value = next as typeof state.value;
      },
    });
    slot.ref(element);
    slot.mount(key);
    return { element, title, notes, slot };
  };
  const run = async (input: Parameters<typeof highlightView>[1]) => {
    const result = highlightView(registry, input, browser.env, marks);
    await vi.advanceTimersByTimeAsync(10);
    return result;
  };
  return { browser, registry, marks, mount, run };
}

describe("highlightView", () => {
  it("scrolls the view into the middle, marks it for two seconds, and reports how much of it shows", async () => {
    const { browser, mount, run } = setup();
    const { element } = mount(form);
    browser.setRect(element, 2000, 100);
    browser.onScroll((scrolled) => browser.setRect(scrolled, 250, 100));
    expect(await run({ view: "form" })).toEqual({ shown: 1 });
    expect(browser.scrolled()).toEqual([element]);
    expect(element.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
    await vi.advanceTimersByTimeAsync(1980);
    expect(element.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(element.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
  });

  it("starts the two seconds when the scroll has settled, not when it began", async () => {
    const { browser, mount, run } = setup();
    const { element } = mount(form);
    let finish!: () => void;
    browser.onScroll(() => new Promise<void>((resolve) => (finish = resolve)));
    const result = run({ view: "form" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(element.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(10);
    await result;
    await vi.advanceTimersByTimeAsync(1980);
    expect(element.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
  });

  it("targets a keyed item by key", async () => {
    const { browser, mount, run } = setup();
    mount(row, "a");
    const b = mount(row, "b");
    await run({ view: "row", key: "b" });
    expect(browser.scrolled()).toEqual([b.element]);
  });

  it("focuses and marks the named field instead of the view", async () => {
    const { browser, mount, run } = setup();
    const { element, notes } = mount(form);
    expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
    expect(browser.document.activeElement).toBe(notes);
    expect(notes.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
    expect(element.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
    expect(browser.scrolled()).toEqual([notes]);
  });

  it("points at a field without focusing it when the primary pointer is not fine, so no software keyboard opens", async () => {
    const { browser, mount, run } = setup();
    const { notes } = mount(form);
    browser.setFinePointer(false);
    expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
    expect(browser.document.activeElement).not.toBe(notes);
    expect(notes.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
    expect(browser.scrolled()).toEqual([notes]);
  });

  it.each([
    ["an unknown view", { view: "nope" }],
    ["a keyed view without a key", { view: "row" }],
    ["a key that is not on screen", { view: "row", key: "zzz" }],
  ])("refuses %s with not_mounted", async (_, input) => {
    const { mount, run } = setup();
    mount(row, "a");
    expect(await run(input)).toMatchObject({ code: "not_mounted" });
  });

  it("refuses a view bound without a ref, which has no element to point at", async () => {
    const { registry, run } = setup();
    registry.track(form, { get: () => ({ title: "", notes: "" }) }).mount(undefined);
    expect(await run({ view: "form" })).toMatchObject({ code: "not_mounted" });
  });

  it("refuses a field the view does not have on screen, naming it", async () => {
    const { browser, mount, run } = setup();
    mount(form);
    expect(await run({ view: "form", field: "due" })).toEqual({
      code: "not_mounted",
      message: expect.stringContaining("due"),
      issues: [{ path: "field", message: "due" }],
    });
    expect(browser.scrolled()).toEqual([]);
  });

  describe("while the user is typing elsewhere", () => {
    const editables: [string, (document: Document) => HTMLElement][] = [
      ["an input", (d) => d.createElement("input")],
      ["a textarea", (d) => d.createElement("textarea")],
      ["a select", (d) => d.createElement("select")],
      [
        "a contenteditable element",
        (d) => {
          const div = d.createElement("div");
          div.setAttribute("contenteditable", "true");
          div.tabIndex = 0;
          return div;
        },
      ],
    ];

    it.each(editables)(
      "refuses with user_editing when %s has focus, before it scrolls or moves focus",
      async (_, create) => {
        const { browser, mount, run } = setup();
        const { notes } = mount(form);
        const typing = create(browser.document);
        browser.document.body.appendChild(typing);
        typing.focus();
        vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
        expect(await run({ view: "form", field: "notes" })).toMatchObject({
          code: "user_editing",
        });
        expect(browser.scrolled()).toEqual([]);
        expect(browser.document.activeElement).toBe(typing);
        expect(notes.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
      },
    );

    it("refuses to scroll a whole view away from a field the user is typing in", async () => {
      const { browser, mount, run } = setup();
      const { title } = mount(form);
      title.focus();
      vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
      expect(await run({ view: "form" })).toMatchObject({
        code: "user_editing",
        issues: [{ path: "title" }],
      });
      expect(browser.scrolled()).toEqual([]);
    });

    it("points as usual when the window is not focused, when the field is the one being typed in, or when focus sits on something that takes no typing", async () => {
      const { browser, mount, run } = setup();
      const { title, notes } = mount(form);
      const hasFocus = vi.spyOn(browser.document, "hasFocus").mockReturnValue(false);
      title.focus();
      expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
      hasFocus.mockReturnValue(true);
      notes.focus();
      expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
      const checkbox = browser.document.createElement("input");
      checkbox.type = "checkbox";
      browser.document.body.appendChild(checkbox);
      checkbox.focus();
      expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
      const button = browser.document.createElement("button");
      browser.document.body.appendChild(button);
      button.focus();
      expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
      expect(browser.document.activeElement).toBe(notes);
    });
  });

  it("is not the user's attention: neither the focus nor the scroll count", async () => {
    const { browser, registry, mount, run } = setup();
    const { element, notes } = mount(form);
    browser.intersect(element, false);
    browser.onScroll((scrolled) => browser.intersect(scrolled, true));
    await run({ view: "form", field: "notes" });
    expect(registry.lastInteracted()).toBeUndefined();
    expect(registry.lastEntered()).toBeUndefined();
    notes.dispatchEvent(new browser.window.FocusEvent("focusin", { bubbles: true }));
    expect(registry.lastInteracted()).toBeDefined();
  });
});

describe("the focus ui_highlight places", () => {
  async function pointAtNotes() {
    const world = setup();
    const mounted = world.mount(form);
    vi.spyOn(world.browser.document, "hasFocus").mockReturnValue(true);
    await world.run({ view: "form", field: "notes" });
    const write = (value: Record<string, unknown>) =>
      setView(world.registry, { view: "form", value }, world.browser.env);
    return { ...world, ...mounted, write };
  }

  it("is not the user typing: the agent can fill the fields it pointed at", async () => {
    const { write } = await pointAtNotes();
    expect(
      await write({ title: "After pointing", notes: "written after pointing" }),
    ).toEqual({
      value: { title: "After pointing", notes: "written after pointing" },
      agentFields: ["title", "notes"],
    });
  });

  it("is not the user typing: the agent can point at another field next", async () => {
    const { browser, run, title } = await pointAtNotes();
    expect(await run({ view: "form", field: "title" })).toEqual({ shown: 0 });
    expect(browser.document.activeElement).toBe(title);
  });

  it.each(["pointerdown", "keydown", "input"])(
    "becomes the user's once they %s in it, and the agent is refused again",
    async (type) => {
      const { browser, run, notes, write } = await pointAtNotes();
      notes.dispatchEvent(new browser.window.Event(type, { bubbles: true }));
      expect(await write({ notes: "agent again" })).toMatchObject({
        code: "user_editing",
        issues: [{ path: "notes" }],
      });
      expect(await run({ view: "form", field: "title" })).toMatchObject({
        code: "user_editing",
      });
    },
  );

  it("does not take over the field the user is already typing in", async () => {
    const { browser, run, notes, write } = await pointAtNotes();
    notes.dispatchEvent(new browser.window.Event("keydown", { bubbles: true }));
    expect(await run({ view: "form", field: "notes" })).toEqual({ shown: 0 });
    expect(await write({ notes: "agent again" })).toMatchObject({ code: "user_editing" });
  });

  it("stays the agent's when the user touches another element", async () => {
    const { browser, title, write } = await pointAtNotes();
    title.dispatchEvent(new browser.window.Event("pointerdown", { bubbles: true }));
    expect(await write({ notes: "still fine" })).toMatchObject({
      agentFields: ["notes"],
    });
  });

  it("becomes the user's when they move focus to it themselves", async () => {
    const { title, notes, write } = await pointAtNotes();
    title.focus();
    notes.focus();
    expect(await write({ notes: "agent again" })).toMatchObject({ code: "user_editing" });
  });
});

describe("HighlightMarks", () => {
  it("restarts the clock when the same element is marked again and clears every mark on dispose", () => {
    const { browser, marks } = setup();
    const a = browser.document.createElement("div");
    const b = browser.document.createElement("div");
    marks.mark(a);
    vi.advanceTimersByTime(1500);
    marks.mark(a);
    marks.mark(b);
    vi.advanceTimersByTime(1500);
    expect(a.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(500);
    expect([a, b].map((el) => el.hasAttribute(HIGHLIGHT_ATTRIBUTE))).toEqual([
      false,
      false,
    ]);
    marks.mark(a);
    marks.dispose();
    expect(a.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
  });
});
