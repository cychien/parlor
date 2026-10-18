import { defineAgentView } from "@parlor/agent-ui";
import { expectTypeOf, test } from "vitest";
import * as z from "zod/mini";

import { type AgentViewHandle, useAgentView } from "./use-agent-view.js";

const draft = z.object({ title: z.string(), notes: z.string() });

test("agentFields holds only the view's writable field names", () => {
  const form = defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    writable: ["title", "notes"],
  });
  expectTypeOf<ReturnType<typeof useAgentView<typeof form>>>().toEqualTypeOf<
    AgentViewHandle<typeof form>
  >();
  expectTypeOf<AgentViewHandle<typeof form>["agentFields"]>().toEqualTypeOf<
    ReadonlySet<"title" | "notes">
  >();
});

test("writable: true makes every schema field a possible agent field", () => {
  const form = defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    writable: true,
  });
  expectTypeOf<AgentViewHandle<typeof form>["agentFields"]>().toEqualTypeOf<
    ReadonlySet<"title" | "notes">
  >();
});

test("a read-only view's agentFields can hold nothing", () => {
  const shown = defineAgentView({ name: "shown", description: "Shown.", schema: draft });
  expectTypeOf<AgentViewHandle<typeof shown>["agentFields"]>().toEqualTypeOf<
    ReadonlySet<never>
  >();
});
