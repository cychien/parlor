import { describe, expect, it, vi } from "vitest";
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
    await expect(invokeAction(registry, "hello", undefined, ctx)).resolves.toMatchObject({
      data: { message: "Hello, world!", scope: "test" },
      reads: [],
    });
    await expect(
      invokeAction(registry, "hello", { name: "Ada" }, ctx),
    ).resolves.toMatchObject({
      data: { message: "Hello, Ada!" },
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
      run: (_, context) => ({ id: "7", db: context.db }),
    }),
  });

  it("gives read-only actions the plain database and reports read tags", async () => {
    await expect(invokeAction(withData, "list", {}, ctx, { data })).resolves.toEqual({
      data: "read-db",
      reads: [["tasks"]],
      writes: [],
    });
  });

  it("runs mutating actions inside a transaction and emits write tags before commit", async () => {
    log.length = 0;
    const onWrite = vi.fn(async () => {
      log.push("event");
    });
    await expect(
      invokeAction(withData, "create", {}, ctx, { data, onWrite }),
    ).resolves.toEqual({
      data: { id: "7", db: "tx-db" },
      reads: [],
      writes: [["tasks", "7"]],
    });
    expect(log).toEqual(["begin", "event", "commit"]);
    expect(onWrite).toHaveBeenCalledWith(
      expect.objectContaining({ name: "create", tx: "tx-db", tags: [["tasks", "7"]] }),
    );
  });
});

describe("invokeAction confirmation", () => {
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
  const gated = createRegistry({
    remove: defineAction({
      description: "remove",
      input: z.object({ id: z.string(), force: z.boolean().default(false) }),
      writes: ["tasks"],
      confirm: true,
      run: ({ id }) => {
        log.push("run");
        return { id };
      },
    }),
    list: defineAction({
      description: "list",
      input: z.object({}),
      run: () => "listed",
    }),
  });
  const from = (source: "ui" | "agent" | "http" | "mcp") => ({ scope: "test", source });

  it.each(["mcp", "agent"] as const)(
    "asks before a %s call with the parsed input, then runs it outside the confirmation's wait",
    async (source) => {
      log.length = 0;
      const confirm = vi.fn(async () => {
        log.push("confirm");
      });
      await expect(
        invokeAction(gated, "remove", { id: "t1" }, from(source), { data, confirm }),
      ).resolves.toMatchObject({ data: { id: "t1" } });
      expect(confirm).toHaveBeenCalledWith({
        action: gated.get("remove"),
        name: "remove",
        input: { id: "t1", force: false },
        ctx: from(source),
      });
      expect(log).toEqual(["confirm", "begin", "run", "commit"]);
    },
  );

  it("stops the call and opens no transaction when the confirmation rejects", async () => {
    log.length = 0;
    const confirm = async () => {
      throw new ActionError("declined", "The user said no.");
    };
    const error = await invokeAction(gated, "remove", { id: "t1" }, from("mcp"), {
      data,
      confirm,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("declined");
    expect(log).toEqual([]);
  });

  it.each(["ui", "http"] as const)(
    "asks for an mcp call but never for a %s call",
    async (source) => {
      log.length = 0;
      const confirm = vi.fn(async () => {});
      await invokeAction(gated, "remove", { id: "t1" }, from(source), { data, confirm });
      expect(confirm).not.toHaveBeenCalled();
      expect(log).toEqual(["begin", "run", "commit"]);
      await invokeAction(gated, "remove", { id: "t1" }, from("mcp"), { data, confirm });
      expect(confirm).toHaveBeenCalledTimes(1);
    },
  );

  it("never asks for an action without confirm, or before the input is valid, but asks once both hold", async () => {
    const confirm = vi.fn(async () => {});
    await invokeAction(gated, "list", {}, from("mcp"), { confirm });
    const error = await invokeAction(gated, "remove", { id: 7 }, from("mcp"), {
      confirm,
    }).catch((e: unknown) => e);
    expect((error as ActionError).code).toBe("invalid_input");
    expect(confirm).not.toHaveBeenCalled();
    await invokeAction(gated, "remove", { id: "t1" }, from("mcp"), { data, confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("fails closed with confirmation_unavailable when a gated call has nobody to ask", async () => {
    log.length = 0;
    const error = await invokeAction(gated, "remove", { id: "t1" }, from("mcp"), {
      data,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("confirmation_unavailable");
    expect(log).toEqual([]);
  });
});
