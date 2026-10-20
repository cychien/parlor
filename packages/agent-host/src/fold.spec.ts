import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import type { AgentUpdate } from "./acp.js";
import { finishFold, type FoldStep, foldUpdate, startFold } from "./fold.js";

const turnId = asId("turn", "u1");

function play(updates: readonly AgentUpdate[], interrupted = false) {
  let fold = startFold(turnId);
  const steps: Omit<FoldStep, "fold">[] = [];
  for (const update of updates) {
    const step = foldUpdate(fold, update, "hello");
    fold = step.fold;
    steps.push({ frames: step.frames, closed: step.closed });
  }
  const finish = finishFold(fold, interrupted);
  return {
    frames: steps.flatMap((step) => step.frames),
    closed: [...steps.flatMap((step) => step.closed), ...finish.closed],
    steps,
    finish,
  };
}

const claudeTurn: readonly AgentUpdate[] = [
  { kind: "thought", text: "The user wants " },
  { kind: "thought", text: "a task." },
  { kind: "text", text: "I'll add " },
  { kind: "text", text: "it." },
  {
    kind: "tool_start",
    toolCallId: "toolu_01",
    title: "mcp__hello__createTask",
    toolKind: "other",
    mcp: { server: "hello", tool: "createTask" },
  },
  { kind: "tool_update", toolCallId: "toolu_01", status: "in_progress" },
  {
    kind: "tool_update",
    toolCallId: "toolu_01",
    status: "completed",
    detail: '{"id":"t9","title":"Buy stamps"}',
  },
  { kind: "mode", modeId: "default" },
  { kind: "text", text: "Added " },
  { kind: "text", text: "Buy stamps." },
];

const codexTurn: readonly AgentUpdate[] = [
  {
    kind: "plan",
    entries: [
      { content: "Create the task", status: "in_progress" },
      { content: "Mark the report done", status: "pending" },
    ],
  },
  {
    kind: "tool_start",
    toolCallId: "call_A",
    title: "mcp.hello.createTask",
    toolKind: "execute",
    mcp: { server: "hello", tool: "createTask" },
  },
  { kind: "tool_update", toolCallId: "call_A", status: "completed" },
  {
    kind: "tool_start",
    toolCallId: "call_B",
    title: "date",
    toolKind: "execute",
  },
  { kind: "tool_update", toolCallId: "call_B", status: "failed", detail: "denied" },
  {
    kind: "plan",
    entries: [
      { content: "Create the task", status: "completed" },
      { content: "Mark the report done", status: "completed" },
    ],
  },
  { kind: "text", text: "Both " },
  { kind: "text", text: "done." },
];

describe("the fold", () => {
  it("T4-04: folds a Claude Code turn into streamed frames and durable items", () => {
    const { frames, closed } = play(claudeTurn);
    expect(frames).toEqual([
      {
        type: "delta",
        itemId: "u1.1",
        kind: "reasoning",
        offset: 0,
        text: "The user wants ",
      },
      { type: "delta", itemId: "u1.1", kind: "reasoning", offset: 15, text: "a task." },
      { type: "delta", itemId: "u1.2", kind: "reply", offset: 0, text: "I'll add " },
      { type: "delta", itemId: "u1.2", kind: "reply", offset: 9, text: "it." },
      {
        type: "item",
        item: {
          id: "u1.3",
          kind: "tool",
          title: "mcp__hello__createTask",
          status: "pending",
        },
      },
      {
        type: "item",
        item: {
          id: "u1.3",
          kind: "tool",
          title: "mcp__hello__createTask",
          status: "running",
        },
      },
      { type: "delta", itemId: "u1.4", kind: "reply", offset: 0, text: "Added " },
      { type: "delta", itemId: "u1.4", kind: "reply", offset: 6, text: "Buy stamps." },
    ]);
    expect(closed).toEqual([
      { id: "u1.1", kind: "reasoning", body: { text: "The user wants a task." } },
      { id: "u1.2", kind: "reply", body: { text: "I'll add it." } },
      {
        id: "u1.3",
        kind: "tool",
        body: {
          title: "mcp__hello__createTask",
          tool: { kind: "app", name: "createTask" },
          status: "done",
          detail: '{"id":"t9","title":"Buy stamps"}',
        },
      },
      { id: "u1.4", kind: "reply", body: { text: "Added Buy stamps." } },
    ]);
  });

  it("T4-04: folds a Codex turn, its plan revised in place and written once at the end", () => {
    const { frames, closed } = play(codexTurn);
    expect(frames).toEqual([
      {
        type: "item",
        item: {
          id: "u1.0",
          kind: "plan",
          entries: [
            { content: "Create the task", status: "in_progress" },
            { content: "Mark the report done", status: "pending" },
          ],
        },
      },
      {
        type: "item",
        item: {
          id: "u1.1",
          kind: "tool",
          title: "mcp.hello.createTask",
          status: "pending",
        },
      },
      {
        type: "item",
        item: { id: "u1.2", kind: "tool", title: "date", status: "pending" },
      },
      {
        type: "item",
        item: {
          id: "u1.0",
          kind: "plan",
          entries: [
            { content: "Create the task", status: "completed" },
            { content: "Mark the report done", status: "completed" },
          ],
        },
      },
      { type: "delta", itemId: "u1.3", kind: "reply", offset: 0, text: "Both " },
      { type: "delta", itemId: "u1.3", kind: "reply", offset: 5, text: "done." },
    ]);
    expect(closed).toEqual([
      {
        id: "u1.1",
        kind: "tool",
        body: {
          title: "mcp.hello.createTask",
          tool: { kind: "app", name: "createTask" },
          status: "done",
        },
      },
      {
        id: "u1.2",
        kind: "tool",
        body: {
          title: "date",
          tool: { kind: "local", name: "execute" },
          status: "failed",
          detail: "denied",
        },
      },
      { id: "u1.3", kind: "reply", body: { text: "Both done." } },
      {
        id: "u1.0",
        kind: "plan",
        body: {
          entries: [
            { content: "Create the task", status: "completed" },
            { content: "Mark the report done", status: "completed" },
          ],
        },
      },
    ]);
  });

  it("T4-04: a stop after chunks keeps every character, marks the reply interrupted and cancels open tools", () => {
    const { finish } = play(
      [
        { kind: "text", text: "Working " },
        {
          kind: "tool_start",
          toolCallId: "t1",
          title: "npm test",
          toolKind: "execute",
        },
        { kind: "text", text: "on it" },
      ],
      true,
    );
    expect(finish.frames).toEqual([]);
    expect(finish.closed).toEqual([
      { id: "u1.3", kind: "reply", body: { text: "on it", interrupted: true } },
      {
        id: "u1.2",
        kind: "tool",
        body: {
          title: "npm test",
          tool: { kind: "local", name: "execute" },
          status: "cancelled",
        },
      },
    ]);
    expect(finish.fold.open).toBeUndefined();
  });

  it("T4-04: gives the same ids to the same updates, so a replayed append is a no-op", () => {
    const first = play([...claudeTurn, ...codexTurn]);
    const replay = play([...claudeTurn, ...codexTurn]);
    expect(replay.closed.map((item) => item.id)).toEqual(
      first.closed.map((item) => item.id),
    );
    expect(new Set(first.closed.map((item) => item.id)).size).toBe(first.closed.length);
    for (const item of first.closed) expect(item.id).toMatch(/^u1\.\d+$/);
  });

  it("T4-04: an app tool is only one served by this app's MCP server", () => {
    const { closed } = play([
      {
        kind: "tool_start",
        toolCallId: "x",
        title: "mcp__other__createTask",
        toolKind: "other",
        mcp: { server: "other", tool: "createTask" },
      },
      { kind: "tool_update", toolCallId: "x", status: "completed" },
    ]);
    expect(closed[0]).toMatchObject({
      body: { tool: { kind: "local", name: "createTask" } },
    });
  });

  it("T4-04: ignores empty chunks, mode changes and updates of tools it never saw", () => {
    const { frames, closed } = play([
      { kind: "text", text: "" },
      { kind: "mode", modeId: "plan" },
      { kind: "tool_update", toolCallId: "ghost", status: "completed" },
    ]);
    expect(frames).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("T4-04: truncates a tool's detail to what the log keeps", () => {
    const { closed } = play([
      { kind: "tool_start", toolCallId: "t", title: "cat", toolKind: "read" },
      {
        kind: "tool_update",
        toolCallId: "t",
        status: "completed",
        detail: "x".repeat(5_000),
      },
    ]);
    expect((closed[0]!.body as { detail: string }).detail).toHaveLength(4_000);
  });
});
