import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import type { LoggedItem } from "../items.js";
import { TRANSCRIPT_BUDGET_BYTES, turnContext } from "./context.js";

const base = {
  id: asId("item", "x"),
  threadId: asId("thread", "t1"),
  turnId: asId("turn", "u1"),
  at: 0,
};

const prompt = (seq: number, text: string): LoggedItem<"prompt"> => ({
  ...base,
  id: asId("item", `p${seq}`),
  seq,
  author: "user",
  kind: "prompt",
  body: { text, agent: { hostId: asId("host", "mac"), agentId: "claude" } },
});

const reply = (seq: number, text: string): LoggedItem<"reply"> => ({
  ...base,
  id: asId("item", `r${seq}`),
  seq,
  author: "agent",
  kind: "reply",
  body: { text },
});

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("turnContext", () => {
  it("states who the agent works for, from where, and what its tools are", () => {
    expect(
      turnContext({
        appName: "Hello",
        appOrigin: "https://hello.test",
        account: { name: "Alice", email: "alice@example.com" },
        device: { name: "Alice's iPhone", platform: "ios" },
        instructions: "Tasks are shared.",
        history: [],
      }),
    ).toBe(
      [
        "<parlor-context>",
        "You are working inside Hello (https://hello.test) for Alice <alice@example.com>. They are writing from Alice's iPhone (ios).",
        "The app's tools are its own actions plus ui_* tools that act on the screen of the chat you are in. Some actions wait for the user to approve them in the app before they run.",
        "",
        "Tasks are shared.",
        "</parlor-context>",
      ].join("\n"),
    );
  });

  it("lists the thread so far, oldest first, with prompt, reply and tool lines", () => {
    const history: LoggedItem[] = [
      prompt(1, "add a task"),
      {
        ...base,
        id: asId("item", "t2"),
        seq: 2,
        author: "agent",
        kind: "tool",
        body: {
          title: "Created task",
          tool: { kind: "app", name: "createTask" },
          status: "done",
        },
      },
      reply(3, "Done."),
    ];
    expect(turnContext({ appName: "Hello", appOrigin: "", history })).toBe(
      [
        "<parlor-context>",
        "You are working inside Hello for the signed-in user.",
        "The app's tools are its own actions plus ui_* tools that act on the screen of the chat you are in. Some actions wait for the user to approve them in the app before they run.",
        "",
        "The conversation so far, oldest first:",
        "user: add a task",
        "tool: Created task (done)",
        "assistant: Done.",
        "</parlor-context>",
      ].join("\n"),
    );
  });

  it("cuts the transcript from the oldest end to 8192 bytes", () => {
    expect(TRANSCRIPT_BUDGET_BYTES).toBe(8192);
    const transcriptOf = (history: LoggedItem[]) => {
      const lines = turnContext({ appName: "Hello", appOrigin: "", history }).split("\n");
      return lines.slice(lines.indexOf("The conversation so far, oldest first:") + 1, -1);
    };
    const tail = [prompt(3, "b".repeat(4100)), reply(4, "newest")];
    const fitting = [prompt(1, "oldest"), reply(2, "a".repeat(4055)), ...tail];
    expect(transcriptOf(fitting)).toEqual([
      `assistant: ${"a".repeat(4055)}`,
      `user: ${"b".repeat(4100)}`,
      "assistant: newest",
    ]);
    const over = [prompt(1, "oldest"), reply(2, "a".repeat(4056)), ...tail];
    expect(transcriptOf(over)).toEqual([
      `user: ${"b".repeat(4100)}`,
      "assistant: newest",
    ]);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const history = [prompt(1, "o".repeat(100)), prompt(2, "字".repeat(2700))];
    const lines = turnContext({ appName: "Hello", appOrigin: "", history }).split("\n");
    const start = lines.indexOf("The conversation so far, oldest first:") + 1;
    expect(lines.slice(start, -1)).toEqual([`user: ${"字".repeat(2700)}`]);
  });

  it("keeps the end of a single line longer than the budget", () => {
    const text = `${"x".repeat(9000)}END`;
    const lines = turnContext({
      appName: "Hello",
      appOrigin: "",
      history: [reply(1, text)],
    }).split("\n");
    const kept = lines[lines.indexOf("The conversation so far, oldest first:") + 1] ?? "";
    expect(kept.startsWith("...x")).toBe(true);
    expect(kept.endsWith("xxEND")).toBe(true);
    expect(bytes(kept) + 1).toBeLessThanOrEqual(8192);
  });
});
