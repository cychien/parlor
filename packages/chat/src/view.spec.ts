import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import type { ChatItemBody, LoggedItem } from "./items.js";
import type { OpenTurn, TurnStatus } from "./model.js";
import { foldThread } from "./view.js";

const thread = asId("thread", "t1");
const turn1 = asId("turn", "u1");
const turn2 = asId("turn", "u2");
const host = asId("host", "mac");
const agent = { hostId: host, agentId: "claude" };

let seq = 0;
function prompt(id: string, turnId = turn1, deviceId?: string): LoggedItem<"prompt"> {
  return {
    id: asId("item", id),
    threadId: thread,
    turnId,
    seq: (seq += 1),
    at: 1000,
    author: "user",
    kind: "prompt",
    body: {
      text: `text of ${id}`,
      agent,
      ...(deviceId
        ? {
            signed: {
              deviceId: asId("device", deviceId),
              at: 1,
              signature: {
                keyId: "k",
                presence: "none" as const,
                format: "es256-raw" as const,
                signature: "s",
              },
            },
          }
        : {}),
    },
  };
}

function reply(id: string, text: string, turnId = turn1, interrupted = false) {
  return item("reply", id, turnId, {
    text,
    ...(interrupted ? { interrupted: true as const } : {}),
  });
}

function item<K extends LoggedItem["kind"]>(
  kind: K,
  id: string,
  turnId: typeof turn1,
  body: ChatItemBody<K>,
): LoggedItem<K> {
  const author =
    kind === "prompt" || kind === "answer" || kind === "cancel"
      ? "user"
      : kind === "event"
        ? "system"
        : "agent";
  return {
    id: asId("item", id),
    threadId: thread,
    turnId,
    seq: (seq += 1),
    at: 1000,
    author,
    kind,
    body,
  } as unknown as LoggedItem<K>;
}

const turns = (...states: [typeof turn1, TurnStatus["state"]][]): TurnStatus[] =>
  states.map(([turnId, state]) => ({ turnId, state, agent }));

const fold = (
  input: Partial<Parameters<typeof foldThread>[0]> & { items: LoggedItem[] },
) =>
  foldThread({
    open: [],
    turns: [],
    confirmations: [],
    deviceId: undefined,
    ...input,
  });

describe("foldThread", () => {
  it("renders a finished turn in log order with the turn's state on its prompt", () => {
    seq = 0;
    const items = [
      prompt("p1"),
      item("tool", "u1.1", turn1, {
        title: "Created task",
        tool: { kind: "app", name: "createTask" },
        status: "done",
      }),
      reply("u1.2", "Done."),
    ];
    expect(fold({ items, turns: turns([turn1, "done"]) })).toEqual([
      {
        kind: "prompt",
        id: "p1",
        turnId: "u1",
        text: "text of p1",
        agent,
        state: "done",
        mine: false,
      },
      {
        kind: "tool",
        id: "u1.1",
        turnId: "u1",
        title: "Created task",
        tool: { kind: "app", name: "createTask" },
        status: "done",
        detail: undefined,
      },
      {
        kind: "reply",
        id: "u1.2",
        turnId: "u1",
        text: "Done.",
        streaming: false,
        interrupted: false,
      },
    ]);
  });

  it("marks a prompt as mine only when this device signed it", () => {
    seq = 0;
    const items = [prompt("p1", turn1, "phone"), prompt("p2", turn2, "laptop")];
    const rows = fold({ items, deviceId: asId("device", "phone") });
    expect(rows.map((row) => row.kind === "prompt" && row.mine)).toEqual([true, false]);
  });

  it("keeps an open reply's id when its durable twin replaces it", () => {
    seq = 0;
    const open: OpenTurn[] = [
      {
        turnId: turn1,
        threadId: thread,
        items: [{ id: asId("item", "u1.1"), kind: "reply", text: "Hel" }],
      },
    ];
    const streaming = fold({
      items: [prompt("p1")],
      open,
      turns: turns([turn1, "running"]),
    });
    expect(streaming.map((row) => [row.kind, row.id])).toEqual([
      ["prompt", "p1"],
      ["reply", "u1.1"],
    ]);
    expect(streaming[1]).toEqual({
      kind: "reply",
      id: "u1.1",
      turnId: "u1",
      text: "Hel",
      streaming: true,
      interrupted: false,
    });

    const persisted = fold({
      items: [prompt("p1"), reply("u1.1", "Hello")],
      open,
      turns: turns([turn1, "running"]),
    });
    expect(persisted.map((row) => [row.kind, row.id])).toEqual([
      ["prompt", "p1"],
      ["reply", "u1.1"],
    ]);
    expect(persisted[1]).toMatchObject({ text: "Hello", streaming: false });
  });

  it("shows an open tool as pending without a tool ref", () => {
    seq = 0;
    const open: OpenTurn[] = [
      {
        turnId: turn1,
        threadId: thread,
        items: [
          {
            id: asId("item", "u1.1"),
            kind: "tool",
            title: "Creating",
            status: "running",
          },
        ],
      },
    ];
    expect(
      fold({ items: [prompt("p1")], open, turns: turns([turn1, "running"]) })[1],
    ).toEqual({
      kind: "tool",
      id: "u1.1",
      turnId: "u1",
      title: "Creating",
      tool: undefined,
      status: "running",
      detail: undefined,
    });
  });

  it("drops the open items of a turn that already ended", () => {
    seq = 0;
    const open: OpenTurn[] = [
      {
        turnId: turn1,
        threadId: thread,
        items: [{ id: asId("item", "u1.1"), kind: "reply", text: "Hel" }],
      },
    ];
    const rows = fold({ items: [prompt("p1")], open, turns: turns([turn1, "failed"]) });
    expect(rows.map((row) => row.kind)).toEqual(["prompt"]);
  });

  it("folds an answer into its ask and draws neither the answer nor the cancel", () => {
    seq = 0;
    const askBody: ChatItemBody<"ask"> = {
      question: "Run rm?",
      choices: [{ id: "yes", label: "Yes", effect: "allow_once" }],
      approval: "presence",
    };
    const ask = item("ask", "u1.1", turn1, askBody);
    const answer = item("answer", "a1", turn1, { askId: ask.id, choice: "yes" });
    const open = fold({ items: [prompt("p1"), ask], turns: turns([turn1, "running"]) });
    expect(open[1]).toMatchObject({ kind: "ask", answer: { state: "open" } });
    const answered = fold({
      items: [prompt("p1"), ask, answer],
      turns: turns([turn1, "running"]),
    });
    expect(answered.map((row) => row.kind)).toEqual(["prompt", "ask"]);
    expect(answered[1]).toMatchObject({ answer: { state: "answered", choice: "yes" } });
  });

  it("closes an unanswered ask once its turn ended", () => {
    seq = 0;
    const ask = item("ask", "u1.1", turn1, {
      question: "Run rm?",
      choices: [],
      approval: "computer",
    });
    const rows = fold({ items: [prompt("p1"), ask], turns: turns([turn1, "done"]) });
    expect(rows[1]).toMatchObject({ kind: "ask", answer: { state: "closed" } });
  });

  it("folds a cancel into its turn's prompt while the turn is still stopping", () => {
    seq = 0;
    const items = [
      prompt("p1"),
      reply("u1.1", "Partial", turn1, true),
      item("cancel", "c1", turn1, {}),
    ];
    const rows = fold({ items, turns: turns([turn1, "running"]) });
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "reply"]);
    expect(rows[0]).toMatchObject({ state: "cancelled" });
    expect(rows[1]).toMatchObject({ text: "Partial", interrupted: true });
  });

  it("keeps a finished turn's state when a late cancel arrives", () => {
    seq = 0;
    const items = [prompt("p1"), item("cancel", "c1", turn1, {})];
    expect(fold({ items, turns: turns([turn1, "done"]) })[0]).toMatchObject({
      state: "done",
    });
  });

  it("places this thread's confirmations after the running turn's items", () => {
    seq = 0;
    const open: OpenTurn[] = [
      {
        turnId: turn2,
        threadId: thread,
        items: [{ id: asId("item", "u2.2"), kind: "reply", text: "Wait" }],
      },
    ];
    const rows = fold({
      items: [prompt("p1"), reply("u1.1", "Old"), prompt("p2", turn2)],
      open,
      turns: turns([turn1, "done"], [turn2, "running"]),
      confirmations: [
        { id: "card-1", threadId: "t1" },
        { id: "card-other", threadId: "t9" },
        { id: "card-external" },
      ],
    });
    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["prompt", "p1"],
      ["reply", "u1.1"],
      ["prompt", "p2"],
      ["reply", "u2.2"],
      ["confirm", "card-1"],
    ]);
    expect(rows.at(-1)).toMatchObject({ turnId: "u2" });
  });

  it("gives the same list for the same input", () => {
    seq = 0;
    const input = {
      items: [prompt("p1"), reply("u1.1", "x")],
      turns: turns([turn1, "done"]),
    };
    expect(fold(input)).toEqual(fold(input));
  });
});
