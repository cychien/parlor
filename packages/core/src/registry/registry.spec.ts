import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAction } from "../action.js";
import { createRegistry } from "./registry.js";

const hello = defineAction({
  description: "Say hello.",
  input: z.object({ name: z.string().default("world") }),
  run: ({ name }) => ({ message: `Hello, ${name}!` }),
});

describe("createRegistry", () => {
  it("rejects names that are not camelCase identifiers", () => {
    expect(() => createRegistry({ "say-hello": hello })).toThrow(/Invalid action name/);
    expect(() => createRegistry({ SayHello: hello })).toThrow(/Invalid action name/);
  });

  it("rejects values that were not created with defineAction", () => {
    const fake = { description: "x", input: z.object({}), run: () => 1 };
    expect(() => createRegistry({ fake: fake as never })).toThrow(/defineAction/);
  });

  it("looks up actions by name without touching the prototype chain", () => {
    const registry = createRegistry({ hello });
    expect(registry.get("hello")).toBe(hello);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.get("toString")).toBeUndefined();
    expect(registry.names()).toEqual(["hello"]);
  });

  it("describes actions with a JSON schema for the input", () => {
    const [descriptor] = createRegistry({ hello }).describe();
    expect(descriptor).toMatchObject({
      name: "hello",
      description: "Say hello.",
      mutating: false,
    });
    expect(descriptor?.inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string", default: "world" } },
    });
  });
});
