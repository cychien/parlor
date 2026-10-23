# create-parlor

Create a [Parlor](https://parlor.dev) app: actions, a page, and an agent sidebar that drives your own coding agent.

```sh
pnpm create parlor my-app
npm create parlor@latest my-app
yarn create parlor my-app
bun create parlor my-app
```

It asks only for the name. `--yes` never prompts; `--no-install`, `--no-git`, `--package-manager <npm|pnpm|yarn|bun>`, `--add auth` and `--dry-run` change the defaults. The first action in the app it creates:

```ts
import { defineAction } from "@parlor/core";
import { z } from "zod";

export const addTodo = defineAction({
  description: "Add a todo.",
  input: z.object({ title: z.string().trim().min(1) }),
  writes: ["todos"],
  run: ({ title }) => ({ title, done: false }),
});
```

Docs: https://parlor.dev/getting-started/
