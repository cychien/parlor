import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable(
  "todos",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull().default("default"),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("todos_scope_created_at_idx").on(table.scope, table.createdAt)],
);
