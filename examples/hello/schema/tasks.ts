import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull().default("default"),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tasks_scope_created_at_idx").on(table.scope, table.createdAt)],
);
