import { describe, expect, it } from "vitest";

import { allCardsVisible, cardVisible, createSidebarViewStore } from "./sidebar-view.js";

const open = (threadId?: string) => ({ open: true, threadId });
const closed = { open: false, threadId: "thr-1" };

describe("which cards the user can see in the sidebar", () => {
  it("sees a card inline on the open thread", () => {
    expect(cardVisible({ threadId: "thr-1" }, open("thr-1"))).toBe(true);
  });

  it("sees a card that belongs to no thread whenever the sidebar is open", () => {
    expect(cardVisible({}, open("thr-1"))).toBe(true);
    expect(cardVisible({}, open())).toBe(true);
  });

  it("does not see a card of another thread, or of any thread before one is open", () => {
    expect(cardVisible({ threadId: "thr-2" }, open("thr-1"))).toBe(false);
    expect(cardVisible({ threadId: "thr-1" }, open())).toBe(false);
  });

  it("sees nothing while the sidebar is closed", () => {
    expect(cardVisible({ threadId: "thr-1" }, closed)).toBe(false);
    expect(cardVisible({}, closed)).toBe(false);
  });

  it("covers a set only when every card is visible, and never an empty set", () => {
    expect(allCardsVisible([{ threadId: "thr-1" }, {}], open("thr-1"))).toBe(true);
    expect(
      allCardsVisible([{ threadId: "thr-1" }, { threadId: "thr-2" }], open("thr-1")),
    ).toBe(false);
    expect(allCardsVisible([], open("thr-1"))).toBe(false);
  });
});

describe("the sidebar view store", () => {
  it("notifies once per real change", () => {
    const store = createSidebarViewStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));

    store.set({ open: true });
    store.set({ open: true });
    store.set({ threadId: "thr-1" });

    expect(notified).toBe(2);
    expect(store.get()).toEqual({ open: true, threadId: "thr-1" });
  });
});
