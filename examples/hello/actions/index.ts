import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { tasks } from "../schema/index.js";

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
    run: (_, { db }) => db.select().from(tasks).orderBy(asc(tasks.createdAt)),
  }),
  createTask: defineAction({
    description: "Create a task with the given title.",
    input: z.object({ title: z.string().min(1).describe("What needs to be done") }),
    writes: [tasks],
    run: async ({ title }, { db }) => {
      const [task] = await db
        .insert(tasks)
        .values({ id: crypto.randomUUID(), title })
        .returning();
      return task;
    },
  }),
  toggleTask: defineAction({
    description: "Flip a task between done and not done.",
    input: z.object({ id: z.string() }),
    writes: [tasks],
    run: async ({ id }, { db }) => {
      const [current] = await db.select().from(tasks).where(eq(tasks.id, id));
      if (!current) throw new Error(`No task ${id}`);
      const [task] = await db
        .update(tasks)
        .set({ done: !current.done })
        .where(eq(tasks.id, id))
        .returning();
      return task;
    },
  }),
});
