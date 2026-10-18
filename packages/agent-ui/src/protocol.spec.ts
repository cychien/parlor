import { describe, expect, it } from "vitest";

import { parseUiRequest } from "./protocol.js";

const envelope = { id: "r1", origin: { via: "mcp" }, timeoutMs: 1000 };
const parse = (value: unknown) => parseUiRequest(JSON.stringify(value));

describe("parseUiRequest", () => {
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
    expect(parseUiRequest("not json")).toEqual({ ok: false, id: undefined });
  });
});

describe("parseUiRequest navigate", () => {
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

describe("parseUiRequest set", () => {
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
