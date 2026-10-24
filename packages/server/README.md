# @parlor/server

The Parlor server: every action over HTTP and MCP, live updates, auth and plugins, as one web-standard `fetch` handler.

```sh
pnpm add @parlor/server @parlor/core @parlor/data
```

```ts
import { createRegistry } from "@parlor/core/registry";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

const registry = createRegistry({});
const database = await createDatabase({ migrationsFolder: "migrations" });

export default createServer({ actions: registry, database });
```

`parlor dev` serves it; `parlor build` wraps it for Node or a serverless platform. Docs: https://cychien.github.io/parlor/reference/server/
