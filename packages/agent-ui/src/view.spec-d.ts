import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import {
  type AgentViewBinding,
  type AnyAgentView,
  defineAgentView,
  type IsWritable,
  type ViewValue,
  type WritableField,
} from "./view.js";

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

const draft = z.object({ title: z.string(), notes: z.string() });

test("writable names only fields of the schema's output", () => {
  const form = defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    writable: ["title", "notes"],
  });
  expectTypeOf<WritableField<typeof form>>().toEqualTypeOf<"title" | "notes">();
  expectTypeOf<IsWritable<typeof form>>().toEqualTypeOf<true>();
  defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    // @ts-expect-error
    writable: ["title", "due"],
  });
});

test("a view without writable, or with an empty list, is read-only", () => {
  const shown = defineAgentView({ name: "shown", description: "Shown.", schema: draft });
  const empty = defineAgentView({
    name: "empty",
    description: "Empty.",
    schema: draft,
    writable: [],
  });
  expectTypeOf<IsWritable<typeof shown>>().toEqualTypeOf<false>();
  expectTypeOf<IsWritable<typeof empty>>().toEqualTypeOf<false>();
  expectTypeOf<WritableField<typeof shown>>().toEqualTypeOf<never>();
});

test("a writable view's binding requires set, typed by value and changed fields", () => {
  const form = defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    writable: ["title"],
  });
  const get = () => ({ title: "", notes: "" });
  // @ts-expect-error
  const missing: AgentViewBinding<typeof form> = { get };
  void missing;
  const binding: AgentViewBinding<typeof form> = {
    get,
    set: (next, changed) => {
      expectTypeOf(next).toEqualTypeOf<{ title: string; notes: string }>();
      expectTypeOf(changed).toEqualTypeOf<readonly "title"[]>();
    },
  };
  void binding;
  const setState = (value: { title: string; notes: string } | ((prev: never) => never)) =>
    void value;
  const fromState: AgentViewBinding<typeof form> = { get, set: setState };
  void fromState;
});

test("a read-only view's binding refuses set", () => {
  const shown = defineAgentView({ name: "shown", description: "Shown.", schema: draft });
  const get = () => ({ title: "", notes: "" });
  const binding: AgentViewBinding<typeof shown> = { get };
  void binding;
  // @ts-expect-error
  const refused: AgentViewBinding<typeof shown> = { get, set: () => {} };
  void refused;
});

test("a keyed view's binding requires key, a single view's refuses it", () => {
  const row = defineAgentView({
    name: "row",
    description: "A row.",
    keyed: true,
    schema: draft,
    writable: ["notes"],
  });
  const get = () => ({ title: "", notes: "" });
  const set = () => {};
  // @ts-expect-error
  const unkeyed: AgentViewBinding<typeof row> = { get, set };
  void unkeyed;
  const keyed: AgentViewBinding<typeof row> = { key: "t1", get, set };
  void keyed;
  const single = defineAgentView({ name: "single", description: "One.", schema: draft });
  // @ts-expect-error
  const withKey: AgentViewBinding<typeof single> = { key: "t1", get };
  void withKey;
});

test("a writable view is still an AnyAgentView, so routes can list it", () => {
  const form = defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    writable: ["title", "notes"],
  });
  expectTypeOf(form).toExtend<AnyAgentView>();
});

test("writable: true opens every field of the schema's output", () => {
  const form = defineAgentView({
    name: "newTask",
    description: "The new task form.",
    schema: draft,
    writable: true,
  });
  expectTypeOf<WritableField<typeof form>>().toEqualTypeOf<"title" | "notes">();
  expectTypeOf<IsWritable<typeof form>>().toEqualTypeOf<true>();
  const get = () => ({ title: "", notes: "" });
  // @ts-expect-error
  const missing: AgentViewBinding<typeof form> = { get };
  void missing;
  const binding: AgentViewBinding<typeof form> = {
    get,
    set: (_next, changed) => {
      expectTypeOf(changed).toEqualTypeOf<readonly ("title" | "notes")[]>();
    },
  };
  void binding;
});

test("writable: false is read-only", () => {
  const shown = defineAgentView({
    name: "shown",
    description: "Shown.",
    schema: draft,
    writable: false,
  });
  expectTypeOf<IsWritable<typeof shown>>().toEqualTypeOf<false>();
});
