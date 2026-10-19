import { ActionError, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { tasks } from "../schema/index.js";

const owned = (id: string, scope: string) =>
  and(eq(tasks.id, id), eq(tasks.scope, scope));

export const registry = createRegistry({
  hello: defineAction({
    description: "Return a friendly greeting.",
    input: z.object({ name: z.string().min(1).default("world") }),
    run: ({ name }) => ({ message: `Hello, ${name}!` }),
  }),
  listTasks: defineAction({
    description: "List all tasks, oldest first.",
    input: z.object({}),
    reads: [tasks],
    run: (_, { db, scope }) =>
      db.select().from(tasks).where(eq(tasks.scope, scope)).orderBy(asc(tasks.createdAt)),
  }),
  getTask: defineAction({
    description: "Get one task by id.",
    input: z.object({ id: z.string() }),
    reads: ({ id }) => [["tasks", id]],
    run: async ({ id }, { db, scope }) => {
      const [task] = await db.select().from(tasks).where(owned(id, scope));
      if (!task) throw new ActionError("not_found", `No task ${id}`);
      return task;
    },
  }),
  createTask: defineAction({
    description: "Create a task with the given title and optional notes.",
    input: z.object({
      title: z.string().min(1).describe("What needs to be done"),
      notes: z.string().optional().describe("Details, shown on the task's page"),
    }),
    writes: [tasks],
    run: async ({ title, notes }, { db, scope }) => {
      const [task] = await db
        .insert(tasks)
        .values({ id: crypto.randomUUID(), scope, title, notes: notes ?? null })
        .returning();
      return task;
    },
  }),
  toggleTask: defineAction({
    description: "Flip a task between done and not done.",
    input: z.object({ id: z.string() }),
    writes: [tasks],
    run: async ({ id }, { db, scope }) => {
      const [current] = await db.select().from(tasks).where(owned(id, scope));
      if (!current) throw new ActionError("not_found", `No task ${id}`);
      const [task] = await db
        .update(tasks)
        .set({ done: !current.done })
        .where(owned(id, scope))
        .returning();
      return task;
    },
  }),
  deleteTask: defineAction({
    description: "Delete a task by id.",
    input: z.object({ id: z.string() }),
    writes: [tasks],
    confirm: true,
    run: async ({ id }, { db, scope }) => {
      const [task] = await db.delete(tasks).where(owned(id, scope)).returning();
      if (!task) throw new ActionError("not_found", `No task ${id}`);
      return task;
    },
  }),
});
