---
title: Data
description: Drizzle tables, migrations, and the database in development and production.
---

Parlor apps keep data in PostgreSQL through Drizzle ORM. In development nothing needs installing: `createDatabase()` runs PGlite, an embedded PostgreSQL, in `.parlor/pglite`. In production set `DATABASE_URL` and the same code talks to a real PostgreSQL server.

## Tables

Tables live in `schema/`:

```ts
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
```

Every table has a `scope` column, and every action filters by `ctx.scope`. See [Actions](/parlor/guides/actions/#scope-every-row).

## Migrations

After changing `schema/`, generate a migration and commit it:

```sh
pnpm db:generate
```

That runs `parlor db generate`, which writes SQL into `migrations/`. `parlor db generate --name add-notes` names the file instead of using a random suffix.

`createDatabase({ migrationsFolder: "migrations" })` applies pending migrations when the server starts, so `pnpm dev` and a deployed server are always up to date. `pnpm db:migrate` (`parlor db migrate`) applies them without starting the server.

## The database handle

```ts
import { createDatabase } from "@parlor/data";

const database = await createDatabase({ migrationsFolder: "migrations" });
// database.db is the Drizzle instance; pass the handle to createServer.
```

| Option             | Default                    | Meaning                                                             |
| ------------------ | -------------------------- | ------------------------------------------------------------------- |
| `url`              | `process.env.DATABASE_URL` | A PostgreSQL connection string. When set, PGlite is not used.       |
| `dataDir`          | `.parlor/pglite`           | Where PGlite keeps its files. `memory://` keeps nothing, for tests. |
| `migrationsFolder` | none                       | Apply the migrations in this folder on start.                       |

In an action, `ctx.db` is that Drizzle instance, typed once `@parlor/data` is imported anywhere in the project.

## Tests

The template's `actions/todos.spec.ts` runs the real server on an in-memory database:

```ts
import { createActionClient } from "@parlor/client";
import type { ActionsOf } from "@parlor/core/registry";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

const registry = createRegistry({});
const database = await createDatabase({ dataDir: "memory://" });
const server = createServer({ actions: registry, database });
export const app = createActionClient<ActionsOf<typeof registry>>({
  baseUrl: "http://app.test",
  fetch: (input, init) => server.fetch(new Request(input, init)),
});
```
