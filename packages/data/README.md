# @parlor/data

The app's PostgreSQL database through Drizzle: embedded PGlite in development, `DATABASE_URL` in production, migrations applied on start.

```sh
pnpm add @parlor/data drizzle-orm
```

```ts
import { createDatabase } from "@parlor/data";

const database = await createDatabase({ migrationsFolder: "migrations" });
const rows = await database.db.execute("select 1");
```

Docs: https://parlor.dev/guides/data/
