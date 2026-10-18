import type { ConfirmationOutcome, ConfirmationRequest } from "@parlor/agent-ui/server";
import { ActionError, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type Confirm, createActionRunner } from "./actions.js";

const ran: string[] = [];
const actions = createRegistry({
  remove: defineAction({
    description: "Remove a note.",
    input: z.object({ id: z.string(), soft: z.boolean().default(true) }),
    confirm: true,
    run: ({ id }) => {
      ran.push(id);
      return { removed: id };
    },
  }),
  list: defineAction({ description: "List.", input: z.object({}), run: () => [] }),
});

function runner(confirm?: Confirm) {
  ran.length = 0;
  return createActionRunner({ actions, scope: () => "acme", sync: false, confirm });
}

const answering = (outcome: ConfirmationOutcome, asked: ConfirmationRequest[] = []) =>
  (async (request) => {
    asked.push(request);
    return outcome;
  }) satisfies Confirm;

const request = (client?: string) =>
  new Request("http://app.test/x", {
    method: "POST",
    headers: client ? { "x-parlor-client": client } : {},
  });

const errorOf = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

describe("the confirmation gate in the action runner", () => {
  it("asks with the parsed input, the scope, the caller and the origin, then runs on approval", async () => {
    const asked: ConfirmationRequest[] = [];
    const controller = new AbortController();
    const result = await runner(answering("approved", asked)).run(
      "remove",
      { id: "n1" },
      request("tab-7"),
      "mcp",
      { origin: { via: "mcp", name: "Claude Code" }, signal: controller.signal },
    );
    expect(result.data).toEqual({ removed: "n1" });
    expect(asked).toEqual([
      {
        scope: "acme",
        clientId: "tab-7",
        action: "remove",
        description: "Remove a note.",
        input: { id: "n1", soft: true },
        origin: { via: "mcp", name: "Claude Code" },
        signal: controller.signal,
      },
    ]);
  });

  it("names the source as the origin when the caller did not say who it is", async () => {
    const asked: ConfirmationRequest[] = [];
    await runner(answering("approved", asked)).run(
      "remove",
      { id: "n1" },
      request(),
      "agent",
    );
    expect(asked[0]?.origin).toEqual({ via: "agent" });
  });

  it.each([
    ["declined", "declined"],
    ["timeout", "confirmation_timeout"],
    ["unavailable", "confirmation_unavailable"],
  ] as const)("maps a %s answer to %s and runs nothing", async (outcome, code) => {
    const error = await errorOf(
      runner(answering(outcome)).run("remove", { id: "n1" }, request(), "mcp"),
    );
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe(code);
    expect(ran).toEqual([]);
  });

  it("tells the agent to ask the user to do it themselves when nobody can be asked", async () => {
    const error = await errorOf(
      runner(answering("unavailable")).run("remove", { id: "n1" }, request(), "mcp"),
    );
    expect((error as ActionError).message).toContain("Ask the user");
  });

  it("aborts the call, with the signal's reason, when the confirmation was cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    controller.abort(reason);
    const error = await errorOf(
      runner(answering("cancelled")).run("remove", { id: "n1" }, request(), "mcp", {
        signal: controller.signal,
      }),
    );
    expect(error).toBe(reason);
    expect(ran).toEqual([]);
  });

  it.each(["ui", "http"] as const)(
    "asks for an mcp call but never for a %s call",
    async (source) => {
      const asked: ConfirmationRequest[] = [];
      const gate = runner(answering("declined", asked));
      const result = await gate.run("remove", { id: "n1" }, request(), source);
      expect(result.data).toEqual({ removed: "n1" });
      expect(asked).toEqual([]);
      const refused = await errorOf(gate.run("remove", { id: "n1" }, request(), "mcp"));
      expect((refused as ActionError).code).toBe("declined");
      expect(asked).toHaveLength(1);
    },
  );

  it("never asks for an action without confirm, or about input that is invalid, but asks once both hold", async () => {
    const asked: ConfirmationRequest[] = [];
    const run = runner(answering("declined", asked));
    await run.run("list", {}, request(), "mcp");
    const error = await errorOf(run.run("remove", { id: 7 }, request(), "mcp"));
    expect((error as ActionError).code).toBe("invalid_input");
    expect(asked).toEqual([]);
    await errorOf(run.run("remove", { id: "n1" }, request(), "mcp"));
    expect(asked).toHaveLength(1);
  });

  it("fails closed when nothing can ask, so an agent call never skips the confirmation", async () => {
    const error = await errorOf(runner().run("remove", { id: "n1" }, request(), "mcp"));
    expect((error as ActionError).code).toBe("confirmation_unavailable");
    expect(ran).toEqual([]);
  });
});
