# @parlor/chat

The server half of the agent sidebar: threads, prompts, agent replies and approvals, as a `createServer` plugin.

```sh
pnpm add @parlor/chat
```

```ts
import { chat } from "@parlor/chat/server";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

const database = await createDatabase({ migrationsFolder: "migrations" });

export default createServer({
  actions: createRegistry({}),
  database,
  plugins: [chat()],
});
```

New apps include it. Docs: https://cychien.github.io/parlor/guides/agent-sidebar/
