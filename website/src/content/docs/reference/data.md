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

The handle has `db` (the Drizzle instance), `client`, `driver` (`"pglite"` or `"node-postgres"`), `transaction(run)`, `migrate(folder)` and `close()`. Importing `@parlor/data` anywhere in the project types `ctx.db` in every action as that Drizzle instance.

`client` is the connection under `db` for libraries that take a `pg`-style client: `client.query(text, params)` runs one statement with `$1`, `$2` placeholders and answers its `rows`, on either driver. It runs outside any transaction, so inside an action that writes, use `ctx.db`.

`directUrl` (default `process.env.DATABASE_DIRECT_URL`, then `url`) is a connection that bypasses any pooler. LISTEN and migrations use it: a transaction pooler such as PgBouncer, Neon's pooled endpoint or Hyperdrive cannot hold a LISTEN, so set `DATABASE_URL` to the pooled endpoint and `DATABASE_DIRECT_URL` to the direct one.

On Cloudflare, `createDatabase` does no I/O: the migrations, embedded in the build, run before the server's first request instead.

`resolveDatabaseUrl(env)` and `resolveDirectUrl(env)` return the URLs `createDatabase` would use. See [Data](/parlor/guides/data/).

```ts
import { createConnectionScope } from "@parlor/data";
//       ^?
```

Connections opened inside `scope.run(fn)` belong to that scope and close with `scope.close()`; outside every scope a handle keeps its own for the life of the process. Parlor's Cloudflare build gives each Durable Object one, since workerd cancels I/O started in one context and awaited from another. `handle.db` and `handle.client` follow the scope they are used in, so code that kept them at startup still works.
