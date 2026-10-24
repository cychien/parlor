# @parlor/core

Actions: business logic written once and served as a React hook, an HTTP endpoint and an MCP tool.

```sh
pnpm add @parlor/core zod
```

```ts
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

export const registry = createRegistry({
  greet: defineAction({
    description: "Return a greeting.",
    input: z.object({ name: z.string().default("world") }),
    run: ({ name }) => ({ message: `Hello, ${name}!` }),
  }),
});
```

Start a new app with `pnpm create parlor`. Docs: https://cychien.github.io/parlor/guides/actions/
