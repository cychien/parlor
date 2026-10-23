import { ActionError, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { todos } from "../schema/index.js";

const mine = (id: string, scope: string) => and(eq(todos.id, id), eq(todos.scope, scope));

export const registry = createRegistry({
  listTodos: defineAction({
    description: "List the todos, oldest first.",
    input: z.object({}),
    reads: [todos],
    run: (_, { db, scope }) =>
      db.select().from(todos).where(eq(todos.scope, scope)).orderBy(asc(todos.createdAt)),
  }),
  addTodo: defineAction({
    description: "Add a todo.",
    input: z.object({
      title: z.string().trim().min(1).describe("What needs to be done"),
    }),
    writes: [todos],
    run: async ({ title }, { db, scope }) => {
      const [todo] = await db
        .insert(todos)
        .values({ id: crypto.randomUUID(), scope, title })
        .returning();
      return todo;
    },
  }),
  toggleTodo: defineAction({
    description: "Mark a todo done, or not done again.",
    input: z.object({ id: z.string() }),
    writes: [todos],
    run: async ({ id }, { db, scope }) => {
      const [current] = await db.select().from(todos).where(mine(id, scope));
      if (!current) throw new ActionError("not_found", `No todo ${id}`);
      const [todo] = await db
        .update(todos)
        .set({ done: !current.done })
        .where(mine(id, scope))
        .returning();
      return todo;
    },
  }),
  deleteTodo: defineAction({
    description: "Delete a todo.",
    input: z.object({ id: z.string() }),
    writes: [todos],
    confirm: true,
    run: async ({ id }, { db, scope }) => {
      const [todo] = await db.delete(todos).where(mine(id, scope)).returning();
      if (!todo) throw new ActionError("not_found", `No todo ${id}`);
      return todo;
    },
  }),
});
