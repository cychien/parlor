# Actions

An action is a typed server function. You define it once with `defineAction`, and Parlor serves it to every caller:

- the app's own UI, through `useActionQuery` and `useActionMutation`
- the agent in the sidebar, as a tool
- external agents such as Claude Code, over MCP at `/_parlor/mcp`
- anything else, as `POST /_parlor/actions/<name>`

All of them run the same `run` function with the same input validation, so there is no second API to keep in sync.

## Define an action

```ts
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notes } from "./schema.js";

export const registry = createRegistry({
  listNotes: defineAction({
    description: "List the notes.",
    input: z.object({}),
    reads: [notes],
    run: (_, { db, scope }) => db.select().from(notes).where(eq(notes.scope, scope)),
  }),
  addNote: defineAction({
    description: "Add a note.",
    input: z.object({ body: z.string().min(1).describe("The text of the note") }),
    writes: [notes],
    run: async ({ body }, { db, scope }) => {
      const [note] = await db
        .insert(notes)
        .values({ id: crypto.randomUUID(), scope, body })
        .returning();
      return note;
    },
  }),
});
```

- `description` is what an agent reads to decide when to call the action. Write it for a reader who sees nothing else.
- `input` is a zod schema. Field descriptions (`.describe(...)`) become the tool's parameter docs.
- `run` gets the parsed input and a context: `db`, `scope`, `principal` (who is calling) and `source` (`ui`, `agent`, `mcp` or `http`).

## Scope every row

`ctx.scope` is the partition the caller may see. Without sign-in every caller is in the scope `"default"`; with sign-in each user has their own. Give every table a `scope` column and filter every query by it, as above. That one rule is what keeps one user's data away from another user and from another user's agent.

## Reads and writes keep pages fresh

`reads: [notes]` says the action reads the `notes` table; `writes: [notes]` says it changes it. When a write runs, from the UI, the sidebar or MCP, every open page that holds a query reading `notes` refetches it. This is how a todo the agent adds shows up in your list without a reload.

A read can also name rows instead of whole tables, for an action that reads one item:

```ts
import { defineAction } from "@parlor/core";
import { z } from "zod";

export const getNote = defineAction({
  description: "Get one note.",
  input: z.object({ id: z.string() }),
  reads: ({ id }) => [["notes", id]],
  run: ({ id }) => ({ id }),
});
```

## Ask before an agent changes things

```ts
import { defineAction } from "@parlor/core";
import { z } from "zod";

export const deleteNote = defineAction({
  description: "Delete a note.",
  input: z.object({ id: z.string() }),
  writes: ["notes"],
  confirm: true,
  run: ({ id }) => ({ id }),
});
```

`confirm: true` makes every call from an agent wait until the user approves it in the app. Calls from the app's own UI never ask.

## Errors

Throw an `ActionError` with a code the caller can act on:

```ts
import { ActionError } from "@parlor/core";

export function missing(id: string): never {
  throw new ActionError("not_found", `No note ${id}`);
}
```

You throw `not_found`, `invalid_input`, `unauthenticated`, `forbidden` or `internal`. Parlor itself answers `declined`, `confirmation_timeout` and `confirmation_unavailable` for a `confirm: true` action the user did not approve. Any other thrown error reaches the caller as `internal` with the message `Internal error`.

## Serve the registry

`server.ts` passes the registry to `createServer`:

```ts
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

import { registry } from "./actions.js";

const database = await createDatabase({ migrationsFolder: "migrations" });

export default createServer({ actions: registry, database });
```

See [Pages and hooks](/parlor/guides/pages-and-hooks/) to call actions from React, and [Agents](/parlor/guides/agents/) for MCP.
