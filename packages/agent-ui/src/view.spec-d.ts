import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import { defineAgentView, type ViewValue } from "./view.js";

test("a view takes a zod schema and binds its output", () => {
  const view = defineAgentView({
    name: "task",
    description: "A task row.",
    keyed: true,
    schema: z.object({ title: z.string(), done: z.boolean().default(false) }),
  });
  expectTypeOf<ViewValue<typeof view>>().toEqualTypeOf<{
    title: string;
    done: boolean;
  }>();
});

test("a view takes a zod/mini schema", () => {
  const view = defineAgentView({
    name: "task",
    description: "A task row.",
    schema: zm.object({ title: zm.string(), done: zm.boolean() }),
  });
  expectTypeOf<ViewValue<typeof view>>().toEqualTypeOf<{
    title: string;
    done: boolean;
  }>();
});

test("a view takes any Standard Schema with an object output", () => {
  const schema = {} as StandardSchemaV1<unknown, { readonly text: string }>;
  const view = defineAgentView({ name: "note", description: "A note.", schema });
  expectTypeOf<ViewValue<typeof view>>().toEqualTypeOf<{ readonly text: string }>();
  const scalar = {} as StandardSchemaV1<unknown, string>;
  // @ts-expect-error a view's value is an object
  defineAgentView({ name: "title", description: "A title.", schema: scalar });
});
