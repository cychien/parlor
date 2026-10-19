import { describe, expect, it } from "vitest";

import { parseUiFrame } from "./protocol.js";

const envelope = { id: "r1", origin: { via: "mcp" }, timeoutMs: 1000 };
const parseRaw = (data: string) => {
  const parsed = parseUiFrame(data);
  return parsed.ok ? { ok: true, request: parsed.frame } : parsed;
};
const parse = (value: unknown) => parseRaw(JSON.stringify(value));

describe("parseUiFrame requests", () => {
  it("reads a screen request and keeps only the fields the protocol defines", () => {
    expect(
      parse({
        ...envelope,
        op: "screen",
        input: { extra: 1 },
        origin: { via: "agent", name: "helper", extra: true },
        extra: "dropped",
      }),
    ).toEqual({
      ok: true,
      request: {
        id: "r1",
        op: "screen",
        input: {},
        origin: { via: "agent", name: "helper" },
        timeoutMs: 1000,
      },
    });
  });

  it.each([
    ["an unknown op", { ...envelope, op: "explode", input: {} }],
    ["a missing input", { ...envelope, op: "screen" }],
    ["an array input", { ...envelope, op: "screen", input: [] }],
    ["an unknown origin", { ...envelope, op: "screen", input: {}, origin: { via: "x" } }],
    [
      "a non-string origin name",
      { ...envelope, op: "screen", input: {}, origin: { via: "mcp", name: 1 } },
    ],
    ["a fractional timeout", { ...envelope, op: "screen", input: {}, timeoutMs: 1.5 }],
    ["a zero timeout", { ...envelope, op: "screen", input: {}, timeoutMs: 0 }],
  ])("rejects %s and still reports the request id", (_, value) => {
    expect(parse(value)).toEqual({ ok: false, id: "r1" });
  });

  it("rejects a request without a usable id and reports no id", () => {
    expect(parse({ ...envelope, id: "", op: "screen", input: {} })).toEqual({
      ok: false,
      id: undefined,
    });
    expect(parse({ ...envelope, id: 7, op: "screen", input: {} })).toEqual({
      ok: false,
      id: undefined,
    });
    expect(parse(null)).toEqual({ ok: false, id: undefined });
    expect(parseRaw("not json")).toEqual({ ok: false, id: undefined });
  });
});

describe("parseUiFrame requests navigate", () => {
  it("reads a navigate request with its optional fields", () => {
    const input = {
      to: "/tasks/$taskId",
      params: { taskId: "t1" },
      search: { tab: "notes", page: 2 },
      replace: true,
    };
    expect(parse({ ...envelope, op: "navigate", input: { ...input, extra: 1 } })).toEqual(
      { ok: true, request: { ...envelope, op: "navigate", input } },
    );
    expect(parse({ ...envelope, op: "navigate", input: { to: "/" } })).toEqual({
      ok: true,
      request: { ...envelope, op: "navigate", input: { to: "/" } },
    });
  });

  it.each([
    ["a missing path", {}],
    ["a non-string path", { to: 1 }],
    ["non-string params", { to: "/", params: { taskId: 1 } }],
    ["array params", { to: "/", params: ["t1"] }],
    ["a non-object search", { to: "/", search: "tab=notes" }],
    ["a non-boolean replace", { to: "/", replace: "yes" }],
  ])("rejects %s", (_, input) => {
    expect(parse({ ...envelope, op: "navigate", input })).toEqual({
      ok: false,
      id: "r1",
    });
  });
});

describe("parseUiFrame requests set", () => {
  it("reads a set request with its optional key and keeps only the fields the protocol defines", () => {
    const input = { view: "newTask", value: { title: "Buy", done: false } };
    expect(parse({ ...envelope, op: "set", input: { ...input, extra: 1 } })).toEqual({
      ok: true,
      request: { ...envelope, op: "set", input },
    });
    expect(parse({ ...envelope, op: "set", input: { ...input, key: "t1" } })).toEqual({
      ok: true,
      request: { ...envelope, op: "set", input: { ...input, key: "t1" } },
    });
  });

  it.each([
    ["a missing view", { value: {} }],
    ["a non-string view", { view: 1, value: {} }],
    ["a missing value", { view: "f" }],
    ["a string value", { view: "f", value: "x" }],
    ["an array value", { view: "f", value: [] }],
    ["a non-string key", { view: "f", key: 1, value: {} }],
  ])("rejects %s while reading the same request with a valid input", (_, input) => {
    expect(parse({ ...envelope, op: "set", input })).toEqual({ ok: false, id: "r1" });
    expect(parse({ ...envelope, op: "set", input: { view: "f", value: {} } })).toEqual({
      ok: true,
      request: { ...envelope, op: "set", input: { view: "f", value: {} } },
    });
  });
});

describe("parseUiFrame requests highlight", () => {
  it("reads a highlight request with its optional key and field", () => {
    const input = { view: "task", key: "t1", field: "notes" };
    expect(
      parse({ ...envelope, op: "highlight", input: { ...input, extra: 1 } }),
    ).toEqual({
      ok: true,
      request: { ...envelope, op: "highlight", input },
    });
    expect(parse({ ...envelope, op: "highlight", input: { view: "form" } })).toEqual({
      ok: true,
      request: { ...envelope, op: "highlight", input: { view: "form" } },
    });
  });

  it.each([
    ["a missing view", { field: "notes" }],
    ["a non-string view", { view: 1 }],
    ["a non-string key", { view: "f", key: 1 }],
    ["a non-string field", { view: "f", field: 1 }],
  ])("rejects %s while reading the same request with a valid input", (_, input) => {
    expect(parse({ ...envelope, op: "highlight", input })).toEqual({
      ok: false,
      id: "r1",
    });
    expect(parse({ ...envelope, op: "highlight", input: { view: "f" } })).toEqual({
      ok: true,
      request: { ...envelope, op: "highlight", input: { view: "f" } },
    });
  });
});

describe("parseUiFrame", () => {
  const frame = (value: unknown) => parseUiFrame(JSON.stringify(value));
  const prompt = {
    id: "c1",
    action: "deleteTask",
    description: "Delete a task.",
    input: { id: "t1" },
    origin: { via: "mcp", name: "Claude Code" },
    expiresInMs: 59_000,
  };

  it("reads a confirmations frame and keeps only the fields the protocol defines", () => {
    expect(
      frame({ type: "confirmations", items: [{ ...prompt, extra: 1 }], extra: 2 }),
    ).toEqual({ ok: true, frame: { type: "confirmations", items: [prompt] } });
    expect(frame({ type: "confirmations", items: [] })).toEqual({
      ok: true,
      frame: { type: "confirmations", items: [] },
    });
  });

  it("drops a malformed item instead of the frame, so one bad prompt never hides the others", () => {
    const parsed = frame({
      type: "confirmations",
      items: [
        { ...prompt, id: "" },
        { ...prompt, id: "c2", expiresInMs: -1 },
        { ...prompt, id: "c3", origin: { via: "x" } },
        { ...prompt, id: "c4", action: 7 },
        null,
        prompt,
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      frame: { type: "confirmations", items: [prompt] },
    });
  });

  it("rejects a confirmations frame whose items are not a list", () => {
    expect(frame({ type: "confirmations", items: "none" })).toEqual({
      ok: false,
      id: undefined,
    });
  });

  it("still reads a request, and reports the id of one it cannot read", () => {
    expect(frame({ ...envelope, op: "screen", input: {} })).toEqual({
      ok: true,
      frame: { ...envelope, op: "screen", input: {} },
    });
    expect(frame({ ...envelope, op: "explode", input: {} })).toEqual({
      ok: false,
      id: "r1",
    });
    expect(parseUiFrame("not json")).toEqual({ ok: false, id: undefined });
  });
});

describe("parseUiFrame confirmations", () => {
  const card = {
    id: "c1",
    action: "deleteTask",
    description: "Delete a task by id.",
    input: { id: "t1" },
    origin: { via: "agent", name: "Claude" },
    expiresInMs: 59_000,
  };

  it("keeps the chat thread an inline agent's card belongs to", () => {
    const parsed = parseUiFrame(
      JSON.stringify({
        type: "confirmations",
        items: [{ ...card, threadId: "thr_alice_1" }, card],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      frame: {
        type: "confirmations",
        items: [{ ...card, threadId: "thr_alice_1" }, card],
      },
    });
  });

  it("drops a thread id that is not a non-empty string, keeping the card", () => {
    const parsed = parseUiFrame(
      JSON.stringify({
        type: "confirmations",
        items: [
          { ...card, threadId: 7 },
          { ...card, id: "c2", threadId: "" },
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      frame: { type: "confirmations", items: [card, { ...card, id: "c2" }] },
    });
  });
});
