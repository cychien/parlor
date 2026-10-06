import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAction, isAction, isMutating } from "./action.js";

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
