import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ActionContext, defineAction } from "../action.js";
import { ActionError } from "../errors.js";
import { invokeAction } from "./invoke.js";
import { createRegistry } from "./registry.js";

const ctx: ActionContext = { scope: "test", source: "http" };

const registry = createRegistry({
  hello: defineAction({
    description: "Say hello.",
    input: z.object({ name: z.string().default("world") }),
    run: ({ name }, context) => ({ message: `Hello, ${name}!`, scope: context.scope }),
  }),
});

describe("invokeAction", () => {
  it("validates input, applies defaults, and passes the context through", async () => {
    await expect(invokeAction(registry, "hello", undefined, ctx)).resolves.toEqual({
      message: "Hello, world!",
      scope: "test",
    });
    await expect(
      invokeAction(registry, "hello", { name: "Ada" }, ctx),
    ).resolves.toMatchObject({
      message: "Hello, Ada!",
    });
  });

  it("fails with not_found for unknown actions", async () => {
    const error = await invokeAction(registry, "nope", {}, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("not_found");
  });

  it("fails with invalid_input and carries the zod issues", async () => {
    const error = await invokeAction(registry, "hello", { name: 42 }, ctx).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ActionError);
    const actionError = error as ActionError;
    expect(actionError.code).toBe("invalid_input");
    expect(actionError.issues?.[0]?.path).toEqual(["name"]);
    expect(actionError.toBody().error.issues).toHaveLength(1);
  });
});
