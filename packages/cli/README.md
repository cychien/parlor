# @parlor/cli

The `parlor` command: `dev`, `build`, `deploy`, `db`, `add` and `typegen` for a Parlor app.

```sh
pnpm add -D @parlor/cli
pnpm parlor dev
pnpm parlor add auth
```

Its configuration is `parlor.config.ts`:

```ts
import { defineConfig } from "@parlor/config";

export default defineConfig({ app: { id: "com.example.todos", name: "Todos" } });
```

Docs: https://cychien.github.io/parlor/reference/cli/
