import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAction } from "../action.js";
import { ActionError } from "../errors.js";
import { invokeAction } from "./invoke.js";
import { createRegistry } from "./registry.js";

const ctx = { scope: "test", source: "http" as const };

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

describe("invokeAction with a data provider", () => {
  const log: string[] = [];
  const data = {
    read: () => "read-db",
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
      log.push("begin");
      const result = await run("tx-db");
      log.push("commit");
      return result;
    },
  };
  const withData = createRegistry({
    list: defineAction({
      description: "list",
      input: z.object({}),
      reads: ["tasks"],
      run: (_, context) => context.db,
    }),
    create: defineAction({
      description: "create",
      input: z.object({}),
      writes: ["tasks"],
      run: (_, context) => context.db,
    }),
  });

  it("gives read-only actions the plain database", async () => {
    await expect(invokeAction(withData, "list", {}, ctx, { data })).resolves.toBe(
      "read-db",
    );
  });

  it("runs mutating actions inside a transaction", async () => {
    log.length = 0;
    await expect(invokeAction(withData, "create", {}, ctx, { data })).resolves.toBe(
      "tx-db",
    );
    expect(log).toEqual(["begin", "commit"]);
  });
});
