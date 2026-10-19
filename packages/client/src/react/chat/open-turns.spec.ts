import type { ChatFrame, LoggedItem, OpenTurn } from "@parlor/chat";
import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import {
  applyFrame,
  mergeSnapshot,
  NO_OPEN_TURNS,
  type OpenTurns,
  pruneOpen,
} from "./open-turns.js";

const threadId = asId("thread", "thr_1");
const turnId = asId("turn", "turn_1");
const replyId = asId("item", "turn_1.1");
const toolId = asId("item", "turn_1.2");

const delta = (offset: number, text: string): ChatFrame => ({
  type: "delta",
  threadId,
  turnId,
  itemId: replyId,
  kind: "reply",
  offset,
  text,
});

const apply = (frames: ChatFrame[], from: OpenTurns = NO_OPEN_TURNS) =>
  frames.reduce(applyFrame, from);

const textOf = (open: OpenTurns) =>
  open.turns
    .get(turnId)
    ?.items.map((item) => [item.id, "text" in item ? item.text : null]);

describe("applyFrame", () => {
  it("joins deltas in offset order into one open reply", () => {
    const open = apply([delta(0, "Hel"), delta(3, "lo, "), delta(7, "world")]);
    expect(textOf(open)).toEqual([[replyId, "Hello, world"]]);
  });

  it("skips a delta whose offset was already shown", () => {
    const open = apply([
      delta(0, "Hel"),
      delta(3, "lo"),
      delta(3, "lo"),
      delta(0, "Hel"),
    ]);
    expect(textOf(open)).toEqual([[replyId, "Hello"]]);
  });

  it("appends only the unseen tail of a delta that overlaps what is shown", () => {
    const open = apply([delta(0, "Hel"), delta(1, "ello!")]);
    expect(textOf(open)).toEqual([[replyId, "Hello!"]]);
  });

  it("freezes a reply at a gap, so a hole is never drawn", () => {
    const open = apply([delta(0, "Hel"), delta(9, "world"), delta(3, "lo")]);
    expect(textOf(open)).toEqual([[replyId, "Hel"]]);
    expect([...open.gapped]).toEqual([replyId]);
  });

  it("ignores the middle of a reply it never saw begin", () => {
    const open = apply([delta(5, "world")]);
    expect(open.turns.size).toBe(0);
    expect([...open.gapped]).toEqual([replyId]);
  });

  it("replaces a tool's state and keeps first-seen order", () => {
    const tool = (status: "pending" | "running"): ChatFrame => ({
      type: "item",
      threadId,
      turnId,
      item: { id: toolId, kind: "tool", title: "Created task", status },
    });
    const open = apply([delta(0, "Hi"), tool("pending"), tool("running")]);
    expect(open.turns.get(turnId)?.items).toEqual([
      { id: replyId, kind: "reply", text: "Hi" },
      { id: toolId, kind: "tool", title: "Created task", status: "running" },
    ]);
  });

  it("forgets the turn when it settles", () => {
    const open = apply([delta(0, "Hi"), { type: "settled", threadId, turnId }]);
    expect(open.turns.size).toBe(0);
  });
});

describe("mergeSnapshot", () => {
  const snapshot = (text: string): OpenTurn => ({
    turnId,
    threadId,
    items: [{ id: replyId, kind: "reply", text }],
  });

  it("keeps the longer text when frames ran ahead of a late snapshot", () => {
    const open = mergeSnapshot(apply([delta(0, "Hello, wor")]), [snapshot("Hello")]);
    expect(textOf(open)).toEqual([[replyId, "Hello, wor"]]);
  });

  it("takes the snapshot's text when it is ahead", () => {
    const open = mergeSnapshot(apply([delta(0, "He")]), [snapshot("Hello")]);
    expect(textOf(open)).toEqual([[replyId, "Hello"]]);
  });

  it("then continues from the snapshot's length without repeating it", () => {
    const merged = mergeSnapshot(NO_OPEN_TURNS, [snapshot("Hello")]);
    expect(textOf(apply([delta(0, "Hel"), delta(5, ", world")], merged))).toEqual([
      [replyId, "Hello, world"],
    ]);
  });
});

describe("pruneOpen", () => {
  const persisted = new Map<string, LoggedItem>([
    [
      replyId,
      {
        id: replyId,
        threadId,
        turnId,
        seq: 2,
        at: 1,
        author: "agent",
        kind: "reply",
        body: { text: "Hello" },
      },
    ],
  ]);

  it("drops an open item once its durable twin has arrived", () => {
    const open = apply([delta(0, "Hel")]);
    expect(pruneOpen(open, persisted, [])).toEqual(NO_OPEN_TURNS);
  });

  it("drops the open items of a turn that is over", () => {
    const open = apply([delta(0, "Hel")]);
    const statuses = [
      {
        turnId,
        state: "cancelled" as const,
        agent: { hostId: asId("host", "h"), agentId: "claude" },
      },
    ];
    expect(pruneOpen(open, new Map(), statuses).turns.size).toBe(0);
  });

  it("keeps what still streams", () => {
    const open = apply([delta(0, "Hel")]);
    expect(textOf(pruneOpen(open, new Map(), []))).toEqual([[replyId, "Hel"]]);
  });
});
