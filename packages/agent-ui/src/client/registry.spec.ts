// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAgentView } from "../view.js";
import { fakeBrowser } from "./fake-browser.testing.js";
import { createViewRegistry, NO_AGENT_WRITES } from "./registry.js";

const schema = z.object({ text: z.string() });
const note = defineAgentView({ name: "note", description: "A note.", schema });
const row = defineAgentView({ name: "row", description: "A row.", keyed: true, schema });

function setup() {
  const registry = createViewRegistry(fakeBrowser().env);
  const track = (view: Parameters<typeof registry.track>[0], key?: string, text = "") => {
    const slot = registry.track(view, { ...(key ? { key } : {}), get: () => ({ text }) });
    return { slot, unmount: slot.mount(key) };
  };
  return { registry, track };
}

describe("registry find", () => {
  it("finds a single view by name and a keyed one by name and key", () => {
    const { registry, track } = setup();
    track(note, undefined, "n");
    track(row, "a", "A");
    track(row, "b", "B");
    expect(registry.find({ view: "note" })?.binding.get()).toEqual({ text: "n" });
    expect(registry.find({ view: "row", key: "b" })?.binding.get()).toEqual({
      text: "B",
    });
  });

  it("finds nothing for an unknown name, a missing or wrong key, or an unmounted view", () => {
    const { registry, track } = setup();
    const { unmount } = track(note);
    track(row, "a");
    expect(registry.find({ view: "nope" })).toBeUndefined();
    expect(registry.find({ view: "row" })).toBeUndefined();
    expect(registry.find({ view: "row", key: "zzz" })).toBeUndefined();
    expect(registry.find({ view: "note", key: "a" })).toBeUndefined();
    unmount();
    expect(registry.find({ view: "note" })).toBeUndefined();
  });

  it("finds the newest of two mounts of the same identity, the one a snapshot shows", () => {
    const { registry, track } = setup();
    track(note, undefined, "old");
    track(note, undefined, "new");
    expect(registry.find({ view: "note" })?.binding.get()).toEqual({ text: "new" });
  });
});

describe("registry remember", () => {
  it("merges values into the mount's writes, replacing the map and notifying subscribers", () => {
    const { registry, track } = setup();
    const { slot } = track(note);
    const listener = vi.fn();
    slot.subscribeWrites(listener);
    const before = slot.writes();
    const mounted = registry.find({ view: "note" })!;
    registry.remember(mounted, { text: "a" });
    registry.remember(mounted, { other: 1 });
    expect([...slot.writes()]).toEqual([
      ["text", "a"],
      ["other", 1],
    ]);
    expect(slot.writes()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("neither replaces nor notifies when the values equal what is remembered", () => {
    const { registry, track } = setup();
    const { slot } = track(note);
    const mounted = registry.find({ view: "note" })!;
    registry.remember(mounted, { text: "a", list: [1] });
    const snapshot = slot.writes();
    const listener = vi.fn();
    slot.subscribeWrites(listener);
    registry.remember(mounted, { text: "a", list: [1] });
    expect(slot.writes()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying an unsubscribed listener", () => {
    const { registry, track } = setup();
    const { slot } = track(note);
    const listener = vi.fn();
    slot.subscribeWrites(listener)();
    registry.remember(registry.find({ view: "note" })!, { text: "a" });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("registry user input", () => {
  function typing() {
    const browser = fakeBrowser();
    const registry = createViewRegistry(browser.env);
    const slot = registry.track(note, { get: () => ({ text: "" }) });
    const unmount = slot.mount(undefined);
    const element = browser.document.createElement("form");
    const input = browser.document.createElement("input");
    input.name = "text";
    const unnamed = browser.document.createElement("input");
    element.append(input, unnamed);
    browser.document.body.append(element);
    slot.ref(element);
    const listener = vi.fn();
    slot.subscribeWrites(listener);
    const type = (target: Element = input) =>
      target.dispatchEvent(
        new browser.window.Event("input", { bubbles: true }) as unknown as Event,
      );
    const mounted = () => registry.find({ view: "note" })!;
    return {
      browser,
      registry,
      slot,
      unmount,
      element,
      input,
      unnamed,
      listener,
      type,
      mounted,
    };
  }

  it("reports typing only after the owner's own input handlers ran, so nothing re-renders the form first", () => {
    const { browser, registry, listener, type, mounted } = typing();
    registry.remember(mounted(), { text: "agent" });
    const order: string[] = [];
    browser.document.body.addEventListener("input", () => order.push("owner"));
    listener.mockImplementation(() => order.push("registry"));
    type();
    expect(order).toEqual(["owner", "registry"]);
  });

  it("takes the field the user types in out of the agent's writes and keeps the others", () => {
    const { registry, slot, listener, type, mounted } = typing();
    registry.remember(mounted(), { text: "agent", other: "kept" });
    listener.mockClear();
    const before = slot.writes();
    type();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(slot.writes()).not.toBe(before);
    expect([...slot.writes()]).toEqual([["other", "kept"]]);
  });

  it("does not bring a field back when the user types the agent's own text again", () => {
    const { registry, slot, type, mounted } = typing();
    registry.remember(mounted(), { text: "agent" });
    type();
    expect(slot.writes()).toBe(NO_AGENT_WRITES);
  });

  it("replaces the writes snapshot when the typed input has no name, so the owner re-derives", () => {
    const { registry, slot, unnamed, listener, type, mounted } = typing();
    registry.remember(mounted(), { text: "agent" });
    listener.mockClear();
    const before = slot.writes();
    type(unnamed);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(slot.writes()).not.toBe(before);
    expect([...slot.writes()]).toEqual([...before]);
  });

  it("stays out of the way while the agent has written nothing, and once its writes are gone", () => {
    const { registry, listener, type, mounted } = typing();
    type();
    expect(listener).not.toHaveBeenCalled();
    const before = mounted().writes;
    registry.remember(mounted(), { text: "agent" });
    registry.restore(mounted(), before);
    listener.mockClear();
    type();
    expect(registry.find({ view: "note" })?.writes).toBe(NO_AGENT_WRITES);
    expect(listener).not.toHaveBeenCalled();
    registry.remember(mounted(), { text: "agent" });
    listener.mockClear();
    type();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores typing outside the view and after it unmounts", () => {
    const { browser, registry, listener, type, unmount, mounted } = typing();
    registry.remember(mounted(), { text: "agent", other: "kept" });
    listener.mockClear();
    const elsewhere = browser.document.createElement("input");
    elsewhere.name = "other";
    browser.document.body.append(elsewhere);
    type(elsewhere);
    expect(listener).not.toHaveBeenCalled();
    type();
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    const element = mounted().element!;
    unmount();
    element.dispatchEvent(
      new browser.window.Event("input", { bubbles: true }) as unknown as Event,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("registry quietly", () => {
  const interactions = () => {
    const browser = fakeBrowser();
    const registry = createViewRegistry(browser.env);
    const element = browser.document.createElement("div");
    const input = browser.document.createElement("input");
    element.appendChild(input);
    browser.document.body.appendChild(element);
    const slot = registry.track(note, { get: () => ({ text: "" }) });
    slot.ref(element);
    slot.mount(undefined);
    const fire = (type: string) =>
      input.dispatchEvent(
        new browser.window.Event(type, { bubbles: true }) as unknown as Event,
      );
    return { browser, registry, element, fire };
  };

  it("does not record a focus as the user's interaction while the act runs, but does after", async () => {
    const { registry, fire } = interactions();
    await registry.quietly(async () => {
      fire("focusin");
    });
    expect(registry.lastInteracted()).toBeUndefined();
    fire("focusin");
    expect(registry.lastInteracted()?.view.view.name).toBe("note");
  });

  it("still records a pointer press, which is always the user", async () => {
    const { registry, fire } = interactions();
    await registry.quietly(async () => fire("pointerdown"));
    expect(registry.lastInteracted()?.view.view.name).toBe("note");
  });

  it("does not record an element entering the viewport while the act runs", async () => {
    const { browser, registry, element } = interactions();
    browser.intersect(element, false);
    await registry.quietly(async () => browser.intersect(element, true));
    expect(registry.lastEntered()).toBeUndefined();
    browser.intersect(element, false);
    browser.intersect(element, true);
    expect(registry.lastEntered()?.view.view.name).toBe("note");
  });

  it("resumes recording when the act throws", async () => {
    const { registry, fire } = interactions();
    await expect(
      registry.quietly(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    fire("focusin");
    expect(registry.lastInteracted()).toBeDefined();
  });
});
