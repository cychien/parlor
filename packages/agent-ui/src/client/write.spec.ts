// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { UiError } from "../protocol.js";
import { defineAgentView } from "../view.js";
import { fakeBrowser } from "./fake-browser.testing.js";
import { type AnyViewBinding, createViewRegistry } from "./registry.js";
import { agentFieldsOf, jsonEqual, setView } from "./write.js";

const draft = z.object({ title: z.string(), notes: z.string() });

const form = defineAgentView({
  name: "form",
  description: "A form.",
  schema: draft,
  writable: ["title", "notes"],
});
const titleOnly = defineAgentView({
  name: "titleOnly",
  description: "Only the title is writable.",
  schema: draft,
  writable: ["title"],
});
const loose = defineAgentView({
  name: "loose",
  description: "Every field is writable.",
  schema: draft,
  writable: true,
});
const shown = defineAgentView({
  name: "shown",
  description: "Read only.",
  schema: draft,
});
const row = defineAgentView({
  name: "row",
  description: "A row.",
  keyed: true,
  schema: draft,
  writable: ["notes"],
});

function setup() {
  const browser = fakeBrowser();
  const registry = createViewRegistry(browser.env);
  const mount = (
    view: Parameters<typeof registry.track>[0],
    state: { value: Record<string, unknown> },
    options: { key?: string; set?: AnyViewBinding["set"] | null } = {},
  ) => {
    const element = browser.document.createElement("form");
    for (const name of ["title", "notes"]) {
      const input = browser.document.createElement("input");
      input.name = name;
      element.appendChild(input);
    }
    browser.document.body.appendChild(element);
    const set =
      options.set === null
        ? undefined
        : (options.set ??
          ((next: Record<string, unknown>) => {
            state.value = next;
          }));
    const slot = registry.track(view, {
      ...(options.key === undefined ? {} : { key: options.key }),
      get: () => state.value,
      ...(set ? { set } : {}),
    });
    slot.ref(element);
    const unmount = slot.mount(options.key);
    return {
      slot,
      element,
      unmount,
      input: (name: string) => element.querySelector<HTMLInputElement>(`[name=${name}]`)!,
    };
  };
  const run = (input: Parameters<typeof setView>[1]) =>
    setView(registry, input, browser.env);
  return { browser, registry, mount, run };
}

const codeOf = (outcome: unknown) => (outcome as UiError).code;

describe("setView", () => {
  it("merges the sent fields into the current value, applies it through set, and reads it back", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "a", notes: "keep" } };
    const set = vi.fn((next: Record<string, unknown>) => {
      state.value = next;
    });
    mount(form, state, { set });
    expect(await run({ view: "form", value: { title: "Buy stamps" } })).toEqual({
      value: { title: "Buy stamps", notes: "keep" },
      agentFields: ["title"],
    });
    expect(set).toHaveBeenCalledWith({ title: "Buy stamps", notes: "keep" }, ["title"]);
  });

  it("accumulates agentFields across writes and drops a field the user has since changed", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "", notes: "" } };
    mount(form, state);
    await run({ view: "form", value: { title: "Plan trip" } });
    expect(await run({ view: "form", value: { notes: "book hotel" } })).toEqual({
      value: { title: "Plan trip", notes: "book hotel" },
      agentFields: ["title", "notes"],
    });
    state.value = { ...state.value, title: "Plan trip!" };
    expect(await run({ view: "form", value: { notes: "book hotel and car" } })).toEqual({
      value: { title: "Plan trip!", notes: "book hotel and car" },
      agentFields: ["notes"],
    });
  });

  it("records the agent's write before set runs so marking and value land in one commit", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "", notes: "" } };
    let seen: ReadonlyMap<string, unknown> | undefined;
    const mounted = mount(form, state, {
      set: (next) => {
        seen = mounted.slot.writes();
        state.value = next as typeof state.value;
      },
    });
    await run({ view: "form", value: { title: "x" } });
    expect([...seen!]).toEqual([["title", "x"]]);
  });

  it("waits for an asynchronous set", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "", notes: "" } };
    mount(form, state, {
      set: async (next) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.value = next as typeof state.value;
      },
    });
    expect(await run({ view: "form", value: { title: "late" } })).toEqual({
      value: { title: "late", notes: "" },
      agentFields: ["title"],
    });
  });

  it("counts a field the owner normalised as the agent's, with the normalised value", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "", notes: "" } };
    mount(form, state, {
      set: (next) => {
        state.value = {
          ...(next as typeof state.value),
          title: String(next.title).trim(),
        };
      },
    });
    expect(await run({ view: "form", value: { title: "  Buy  " } })).toEqual({
      value: { title: "Buy", notes: "" },
      agentFields: ["title"],
    });
  });

  it("forgets the write and rethrows when set throws", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "", notes: "" } };
    const mounted = mount(form, state, {
      set: () => {
        throw new Error("boom");
      },
    });
    await expect(run({ view: "form", value: { title: "x" } })).rejects.toThrow("boom");
    expect(mounted.slot.writes().size).toBe(0);
  });

  it("targets a keyed item by key", async () => {
    const { mount, run } = setup();
    const a = { value: { title: "A", notes: "" } };
    const b = { value: { title: "B", notes: "" } };
    mount(row, a, { key: "a" });
    mount(row, b, { key: "b" });
    expect(await run({ view: "row", key: "b", value: { notes: "n" } })).toEqual({
      value: { title: "B", notes: "n" },
      agentFields: ["notes"],
    });
    expect(a.value.notes).toBe("");
  });
});

describe("setView refusals", () => {
  it.each([
    ["an unknown view", { view: "nope", value: { title: "x" } }],
    ["a keyed view without a key", { view: "row", value: { notes: "x" } }],
    ["a key that is not on screen", { view: "row", key: "zzz", value: { notes: "x" } }],
    ["a key on a single view", { view: "form", key: "k", value: { title: "x" } }],
  ])("refuses %s with not_mounted", async (_, input) => {
    const { mount, run } = setup();
    mount(form, { value: { title: "", notes: "" } });
    mount(row, { value: { title: "", notes: "" } }, { key: "a" });
    const outcome = await run(input);
    expect(codeOf(outcome)).toBe("not_mounted");
  });

  it("refuses a view that has been unmounted", async () => {
    const { mount, run } = setup();
    mount(form, { value: { title: "", notes: "" } }).unmount();
    expect(codeOf(await run({ view: "form", value: { title: "x" } }))).toBe(
      "not_mounted",
    );
  });

  it("refuses a read-only view and a field outside the list with not_writable, changing nothing", async () => {
    const { mount, run } = setup();
    const onlyTitle = { value: { title: "", notes: "" } };
    const readOnly = { value: { title: "", notes: "" } };
    const set = vi.fn();
    mount(titleOnly, onlyTitle, { set });
    mount(shown, readOnly, { set: null });
    expect(await run({ view: "titleOnly", value: { title: "ok", notes: "no" } })).toEqual(
      {
        code: "not_writable",
        message: expect.stringContaining("titleOnly"),
        issues: [{ path: "notes", message: expect.any(String) }],
      },
    );
    expect(codeOf(await run({ view: "shown", value: { title: "x" } }))).toBe(
      "not_writable",
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("for writable: true, refuses a key the schema does not keep with not_writable", async () => {
    const { mount, run } = setup();
    const state = { value: { title: "", notes: "" } };
    const set = vi.fn((next: Record<string, unknown>) => {
      state.value = next as typeof state.value;
    });
    mount(loose, state, { set });
    expect(await run({ view: "loose", value: { due: "tomorrow" } })).toEqual({
      code: "not_writable",
      message: expect.stringContaining("due"),
      issues: [{ path: "due", message: expect.any(String) }],
    });
    expect(set).not.toHaveBeenCalled();
    expect(await run({ view: "loose", value: { notes: "fine" } })).toEqual({
      value: { title: "", notes: "fine" },
      agentFields: ["notes"],
    });
  });

  it("refuses a value the schema rejects with invalid_value naming the field", async () => {
    const { mount, run } = setup();
    const set = vi.fn();
    mount(form, { value: { title: "", notes: "" } }, { set });
    expect(await run({ view: "form", value: { title: 42 } })).toEqual({
      code: "invalid_value",
      message: expect.any(String),
      issues: [{ path: "title", message: expect.any(String) }],
    });
    expect(set).not.toHaveBeenCalled();
  });

  describe("user_editing", () => {
    const typing = (name: string, hasFocus = true) => {
      const world = setup();
      const state = { value: { title: "Groc", notes: "" } };
      const mounted = world.mount(form, state);
      mounted.input(name).focus();
      vi.spyOn(world.browser.document, "hasFocus").mockReturnValue(hasFocus);
      return { ...world, state };
    };

    it("refuses a field the user has the caret in while the document has focus", async () => {
      const { run, state } = typing("title");
      expect(
        await run({ view: "form", value: { title: "Groceries", notes: "milk" } }),
      ).toEqual({
        code: "user_editing",
        message: expect.any(String),
        issues: [{ path: "title", message: expect.any(String) }],
      });
      expect(state.value).toEqual({ title: "Groc", notes: "" });
    });

    it("lets the write through when the window lost focus, the caret staying where it was", async () => {
      const { run } = typing("title", false);
      expect(
        await run({ view: "form", value: { title: "Groceries", notes: "milk" } }),
      ).toEqual({
        value: { title: "Groceries", notes: "milk" },
        agentFields: ["title", "notes"],
      });
    });

    it("lets through a write to fields other than the one being typed in", async () => {
      const { run } = typing("title");
      expect(await run({ view: "form", value: { notes: "milk" } })).toEqual({
        value: { title: "Groc", notes: "milk" },
        agentFields: ["notes"],
      });
    });

    it("ignores a caret in another view's input", async () => {
      const { run, mount } = typing("title");
      mount(shown, { value: { title: "", notes: "" } }, { set: null })
        .input("title")
        .focus();
      expect(await run({ view: "form", value: { title: "Groceries" } })).toMatchObject({
        agentFields: ["title"],
      });
    });

    it("is checked after not_writable and before invalid_value", async () => {
      const { run } = typing("title");
      expect(codeOf(await run({ view: "form", value: { title: 42 } }))).toBe(
        "user_editing",
      );
    });
  });
});

describe("jsonEqual", () => {
  it.each([
    ["equal strings", "a", "a", true],
    ["different strings", "a", "b", false],
    [
      "equal nested objects regardless of key order",
      { a: [1, { b: 2 }], c: 3 },
      { c: 3, a: [1, { b: 2 }] },
      true,
    ],
    ["objects with different keys", { a: 1 }, { b: 1 }, false],
    ["objects of different size", { a: 1 }, { a: 1, b: 2 }, false],
    ["arrays of different length", [1, 2], [1], false],
    ["an array and an object", [], {}, false],
    ["null and an object", null, {}, false],
    ["NaN with NaN", Number.NaN, Number.NaN, true],
  ])("%s", (_, a, b, expected) => {
    expect(jsonEqual(a, b)).toBe(expected);
  });
});

describe("agentFieldsOf", () => {
  it("keeps the written fields whose current value still equals the write", () => {
    const writes = new Map<string, unknown>([
      ["title", "Buy"],
      ["tags", ["a"]],
      ["notes", "n"],
    ]);
    expect([
      ...agentFieldsOf(writes, { title: "Buy", tags: ["a"], notes: "n!" }),
    ]).toEqual(["title", "tags"]);
  });

  it("is empty without writes", () => {
    expect(agentFieldsOf(new Map(), { title: "x" }).size).toBe(0);
  });
});
