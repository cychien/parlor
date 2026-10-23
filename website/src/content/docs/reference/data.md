---
title: "@parlor/data"
description: createDatabase, PGlite in development and PostgreSQL in production.
---

```sh
pnpm add @parlor/data drizzle-orm
```

```ts
import { createDatabase } from "@parlor/data";
//       ^?
```

Opens the app's database: PostgreSQL at `url` (default `process.env.DATABASE_URL`), else PGlite in `dataDir` (default `.parlor/pglite`; `memory://` keeps nothing). With `migrationsFolder` it applies pending migrations before it resolves.

The handle has `db` (the Drizzle instance), `driver` (`"pglite"` or `"node-postgres"`), `transaction(run)`, `migrate(folder)` and `close()`. Importing `@parlor/data` anywhere in the project types `ctx.db` in every action as that Drizzle instance.

`resolveDatabaseUrl(env)` returns the URL `createDatabase` would use. See [Data](/guides/data/).
