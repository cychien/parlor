import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import type { OpenItem } from "./model.js";
import { applyFrame } from "./open-turns.js";
import { parseChatFrame } from "./protocol.js";

const ids = { threadId: "t1", turnId: "u1" };

describe("parseChatFrame", () => {
  it("reads a delta", () => {
    const data = JSON.stringify({
      type: "delta",
      ...ids,
      itemId: "u1.1",
      kind: "reply",
      offset: 5,
      text: "lo",
    });
    expect(parseChatFrame(data)).toEqual({
      type: "delta",
      threadId: "t1",
      turnId: "u1",
      itemId: "u1.1",
      kind: "reply",
      offset: 5,
      text: "lo",
    });
  });

  it("reads a tool item, a plan item and a settled frame", () => {
    expect(
      parseChatFrame(
        JSON.stringify({
          type: "item",
          ...ids,
          item: { id: "u1.2", kind: "tool", title: "Creating", status: "running" },
        }),
      ),
    ).toEqual({
      type: "item",
      threadId: "t1",
      turnId: "u1",
      item: { id: "u1.2", kind: "tool", title: "Creating", status: "running" },
    });
    expect(
      parseChatFrame(
        JSON.stringify({
          type: "item",
          ...ids,
          item: {
            id: "u1.3",
            kind: "plan",
            entries: [{ content: "a", status: "in_progress" }],
          },
        }),
      ),
    ).toEqual({
      type: "item",
      threadId: "t1",
      turnId: "u1",
      item: {
        id: "u1.3",
        kind: "plan",
        entries: [{ content: "a", status: "in_progress" }],
      },
    });
    expect(parseChatFrame(JSON.stringify({ type: "settled", ...ids }))).toEqual({
      type: "settled",
      threadId: "t1",
      turnId: "u1",
    });
  });

  it.each([
    ["not json", "{"],
    ["not an object", "[1]"],
    ["an unknown type", JSON.stringify({ type: "later", ...ids })],
    ["no thread", JSON.stringify({ type: "settled", turnId: "u1" })],
    [
      "a fractional offset",
      JSON.stringify({
        type: "delta",
        ...ids,
        itemId: "i",
        kind: "reply",
        offset: 1.5,
        text: "",
      }),
    ],
    [
      "a negative offset",
      JSON.stringify({
        type: "delta",
        ...ids,
        itemId: "i",
        kind: "reply",
        offset: -1,
        text: "",
      }),
    ],
    [
      "a delta for a tool",
      JSON.stringify({
        type: "delta",
        ...ids,
        itemId: "i",
        kind: "tool",
        offset: 0,
        text: "",
      }),
    ],
    [
      "a tool that finished",
      JSON.stringify({
        type: "item",
        ...ids,
        item: { id: "i", kind: "tool", title: "x", status: "done" },
      }),
    ],
  ])("refuses %s", (_name, data) => {
    expect(parseChatFrame(data)).toBeUndefined();
  });
});

describe("applyFrame", () => {
  const item = asId("item", "u1.1");
  const delta = (offset: number, text: string) =>
    ({
      type: "delta",
      threadId: asId("thread", "t1"),
      turnId: asId("turn", "u1"),
      itemId: item,
      kind: "reply",
      offset,
      text,
    }) as const;

  it("grows an item delta by delta", () => {
    const first = applyFrame([], delta(0, "Hel"));
    const second = first && applyFrame(first.items, delta(3, "lo"));
    expect(second?.items).toEqual([{ id: "u1.1", kind: "reply", text: "Hello" }]);
  });

  it("skips a duplicate offset", () => {
    const held: OpenItem[] = [{ id: item, kind: "reply", text: "Hello" }];
    expect(applyFrame(held, delta(3, "lo"))).toBeUndefined();
    expect(applyFrame(held, delta(0, "Hello"))).toBeUndefined();
  });

  it("cuts an overlapping delta to the text not held yet", () => {
    const held: OpenItem[] = [{ id: item, kind: "reply", text: "Hel" }];
    const applied = applyFrame(held, delta(1, "ello"));
    expect(applied?.items).toEqual([{ id: "u1.1", kind: "reply", text: "Hello" }]);
    expect(applied?.frame).toMatchObject({ offset: 3, text: "lo" });
  });

  it("waits for the durable item after a gap", () => {
    const held: OpenItem[] = [{ id: item, kind: "reply", text: "Hel" }];
    expect(applyFrame(held, delta(5, "xyz"))).toBeUndefined();
    expect(applyFrame([], delta(2, "xyz"))).toBeUndefined();
  });

  it("replaces a tool's state in place", () => {
    const tool = (status: "pending" | "running") =>
      ({
        type: "item",
        threadId: asId("thread", "t1"),
        turnId: asId("turn", "u1"),
        item: { id: asId("item", "u1.2"), kind: "tool", title: "Creating", status },
      }) as const;
    const first = applyFrame([], tool("pending"));
    const second = first && applyFrame(first.items, tool("running"));
    expect(second?.items).toEqual([
      { id: "u1.2", kind: "tool", title: "Creating", status: "running" },
    ]);
  });
});
