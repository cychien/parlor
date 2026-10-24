# @parlor/config

`parlor.config.ts` for a Parlor app, and the strict TypeScript options every app extends.

```sh
pnpm add -D @parlor/config
```

```ts
import { defineConfig } from "@parlor/config";

export default defineConfig({
  app: { id: "com.example.todos", name: "Todos" },
});
```

`tsconfig.json`: `{ "extends": "@parlor/config/tsconfig" }`. Docs: https://cychien.github.io/parlor/reference/config/
