---
title: Getting started
description: Create an app, run it, let the agent use it, add an action, then add sign-in.
---

You need Node.js 24 or later and one of pnpm, npm, yarn or bun. The examples use pnpm; every command has the same shape with the others (`npm run dev`, `npx parlor ...`).

## Create the app

```sh
pnpm create parlor my-app
cd my-app
```

`create-parlor` asks only for the name, installs the dependencies and makes the first git commit. Pass `--yes` to accept every default without a prompt, for example from a script or an agent.

## Run it

```sh
pnpm dev
```

Open the `Local:` URL it prints, `http://localhost:5173` unless that port is taken. The page is a todo list. Add a todo to see it work.

`pnpm dev` runs three things: the server with your actions on port 3000, the web app on port 5173, and a small host that lets the coding agents on this computer reach the app. A port another program holds moves to the next free one, and `pnpm dev` says so.

## Let the agent use it

Press **Agent** in the header. The sidebar lists the coding agents installed on this computer, such as Claude Code or Codex. Pick one and send:

```text
Add a todo called Buy milk
```

The agent calls the app's `addTodo` action, and the list updates without a reload. Actions marked `confirm: true`, such as `deleteTodo`, ask you to approve the call in the sidebar first.

## Add an action

Actions live in `actions/`. Add one that clears the finished todos, in a new file `actions/clear-done.ts`:

```ts
// @filename: schema/index.ts
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull().default("default"),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
// @filename: actions/clear-done.ts
import "@parlor/data";
// ---cut---
import { defineAction } from "@parlor/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { todos } from "../schema/index.js";

export const clearDone = defineAction({
  description: "Delete every todo that is done.",
  input: z.object({}),
  writes: [todos],
  run: async (_, { db, scope }) => {
    const removed = await db
      .delete(todos)
      .where(and(eq(todos.scope, scope), eq(todos.done, true)))
      .returning();
    return { removed: removed.length };
  },
});
```

Then register it in `actions/index.ts`: import it at the top with the other imports, and add `clearDone` to the object passed to `createRegistry`, next to the actions already there:

```ts
// @filename: actions/clear-done.ts
import { defineAction } from "@parlor/core";
import { z } from "zod";
export const clearDone = defineAction({
  description: "Delete every todo that is done.",
  input: z.object({}),
  run: () => ({ removed: 0 }),
});
// @filename: actions/index.ts
// ---cut---
import { createRegistry } from "@parlor/core/registry";

import { clearDone } from "./clear-done.js";

export const registry = createRegistry({
  clearDone,
});
```

Now call it from the page. Create `src/clear-done.tsx`:

```tsx
// @filename: actions/index.ts
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

export const registry = createRegistry({
  clearDone: defineAction({
    description: "Delete every todo that is done.",
    input: z.object({}),
    writes: ["todos"],
    run: () => ({ removed: 0 }),
  }),
});
// @filename: register.ts
import "@parlor/client";
import type { ActionsOf } from "@parlor/core/registry";
import type { registry } from "./actions/index.js";

declare module "@parlor/client" {
  interface Register {
    actions: ActionsOf<typeof registry>;
  }
}
// @filename: clear-done.tsx
// ---cut---
import { useActionMutation } from "@parlor/client/react";

export function ClearDone() {
  const clear = useActionMutation("clearDone");
  return (
    <button
      type="button"
      onClick={() => clear.mutate({})}
      className="text-sm text-zinc-500 hover:text-zinc-900"
    >
      Clear done
    </button>
  );
}
```

and render it in `src/routes/index.tsx`, below the list: import it with `import { ClearDone } from "../clear-done.js";` and add `<ClearDone />` after the closing `</ul>`. Check a todo, then press **Clear done**.

The agent sees the new action too: ask it to "clear the finished todos". `writes: [todos]` is what refreshes the list for every open page when the action runs.

## Add sign-in

`parlor add auth` edits your files, so it first asks for a clean git tree: then everything it changes shows up as one diff you can review. Commit what you have, then run it:

```sh
git add -A
git commit -m "Add clearDone"
pnpm parlor add auth
```

This installs `@parlor/auth`, adds a sign-in page, wires the server and the client, and generates the migration. Restart `pnpm dev`, create an account, and each user now sees only their own todos. The todos you added before signing in belong to the scope `"default"`, which no signed-in user sees, so the list starts empty.

With sign-in, the sidebar shows a command that connects your computer to your account:

```sh
npx @parlor/agent-host connect http://localhost:5173
```

Run it, press **Connect** in the browser tab it opens, and the tab returns to the app, ready to chat.

To use your agents from another browser or your phone, link it once: it shows a QR code and a short code. Scan the QR with a phone you already use, or type the code under **Link a device** in a browser you already use, then confirm with Face ID or Touch ID. With no linked device at hand, run the `npx @parlor/agent-host link ...` command it shows on your computer.

## Next

- [Actions](/guides/actions/): inputs, reads and writes, confirmation, errors.
- [The agent sidebar](/guides/agent-sidebar/): how the sidebar works and how to change it.
- [Targets](/guides/targets/): the same app on macOS, iOS and Android.
- [Deploy](/guides/deploy/): build the server and the web app for production.
