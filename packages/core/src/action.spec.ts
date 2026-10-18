import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type ActionSource,
  defineAction,
  isAction,
  isMutating,
  needsConfirmation,
} from "./action.js";

describe("defineAction", () => {
  const read = defineAction({
    description: "read",
    input: z.object({}),
    run: () => "ok",
  });
  const write = defineAction({
    description: "write",
    input: z.object({}),
    writes: ["tasks"],
    run: () => "ok",
  });

  it("brands the definition so registries can recognise it", () => {
    expect(isAction(read)).toBe(true);
    expect(isAction({ description: "x", input: z.object({}), run: () => 1 })).toBe(false);
    expect(isAction(null)).toBe(false);
  });

  it("treats an action as mutating only when it declares writes", () => {
    expect(isMutating(read)).toBe(false);
    expect(isMutating(write)).toBe(true);
  });
});

describe("needsConfirmation", () => {
  const gated = defineAction({
    description: "gated",
    input: z.object({}),
    confirm: true,
    run: () => "ok",
  });
  const open = defineAction({
    description: "open",
    input: z.object({}),
    run: () => "ok",
  });
  const notGated = defineAction({
    description: "not gated",
    input: z.object({}),
    confirm: false,
    run: () => "ok",
  });

  it.each<[ActionSource, boolean]>([
    ["mcp", true],
    ["agent", true],
    ["ui", false],
    ["http", false],
  ])("a confirm action called from %s needs confirmation: %s", (source, expected) => {
    expect(needsConfirmation(gated, source)).toBe(expected);
    expect(needsConfirmation(gated, "mcp")).toBe(true);
  });

  it("never needs confirmation for an action without confirm: true, while one with it does", () => {
    expect(needsConfirmation(open, "mcp")).toBe(false);
    expect(needsConfirmation(notGated, "agent")).toBe(false);
    expect(needsConfirmation(gated, "agent")).toBe(true);
  });
});
