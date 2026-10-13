import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAction } from "./action.js";
import { readTagsFor, tableName, tagsOverlap, writeTagsFor } from "./tags.js";

describe("tagsOverlap", () => {
  it.each([
    [["tasks"], ["tasks", 43], true],
    [["tasks", 43], ["tasks"], true],
    [["tasks", 43], ["tasks", 43], true],
    [["tasks", 42], ["tasks", 43], false],
    [["tasks"], ["users"], false],
    [[], ["tasks"], true],
  ])("%j vs %j -> %s", (a, b, expected) => {
    expect(tagsOverlap(a, b)).toBe(expected);
  });
});

describe("tag derivation", () => {
  const tasks = { _: { name: "tasks" } };

  it("reads a table name from a string or a table-like object", () => {
    expect(tableName("tasks")).toBe("tasks");
    expect(tableName(tasks)).toBe("tasks");
  });

  it("derives table-level read tags from declared sources", () => {
    const action = defineAction({
      description: "list",
      input: z.object({}),
      reads: [tasks, "users"],
      run: () => [],
    });
    expect(readTagsFor(action, {})).toEqual([["tasks"], ["users"]]);
  });

  it("lets read tags depend on input", () => {
    const action = defineAction({
      description: "get",
      input: z.object({ id: z.string() }),
      reads: ({ id }) => [["tasks", id]],
      run: () => null,
    });
    expect(readTagsFor(action, { id: "42" })).toEqual([["tasks", "42"]]);
  });

  it("derives table-level write tags and defaults to none", () => {
    const write = defineAction({
      description: "update",
      input: z.object({}),
      writes: [tasks],
      run: () => null,
    });
    const read = defineAction({
      description: "read",
      input: z.object({}),
      run: () => null,
    });
    expect(writeTagsFor(write)).toEqual([["tasks"]]);
    expect(writeTagsFor(read)).toEqual([]);
    expect(readTagsFor(read, {})).toEqual([]);
  });
});

describe("writeTagsFor with results", () => {
  const update = defineAction({
    description: "update",
    input: z.object({}),
    writes: ["tasks"],
    run: () => null,
  });

  it("emits primary-key tags when the result carries ids", () => {
    expect(writeTagsFor(update, { id: "42", title: "x" })).toEqual([["tasks", "42"]]);
    expect(writeTagsFor(update, [{ id: 1 }, { id: 2 }])).toEqual([
      ["tasks", 1],
      ["tasks", 2],
    ]);
  });

  it("falls back to table-level tags without ids", () => {
    expect(writeTagsFor(update, { count: 3 })).toEqual([["tasks"]]);
    expect(writeTagsFor(update, undefined)).toEqual([["tasks"]]);
  });
});

describe("tableName with Drizzle tables", () => {
  it("reads the runtime symbol Drizzle stores the name under", () => {
    const table = { [Symbol.for("drizzle:Name")]: "tasks" } as unknown as {
      _: { name: string };
    };
    expect(tableName(table)).toBe("tasks");
  });

  it("rejects objects that are not tables", () => {
    expect(() => tableName({} as never)).toThrow(/Drizzle tables/);
  });
});
