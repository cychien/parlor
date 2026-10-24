---
title: "@parlor/core"
description: defineAction, the action registry, ActionError, principals and ids.
---

```sh
pnpm add @parlor/core zod
```

The shared vocabulary of a Parlor app, with no runtime dependencies beyond zod. Both the server and the client import it.

## @parlor/core

```ts
import { defineAction } from "@parlor/core";
//       ^?
```

Defines an action. The config takes `description`, `input` (a zod schema), `run(input, ctx)`, and optionally `reads`, `writes`, `confirm` and `public`. See [Actions](/parlor/guides/actions/).

```ts
import { ActionError } from "@parlor/core";
//       ^?
```

The error an action throws to answer with a code: `not_found`, `invalid_input`, `unauthenticated`, `forbidden`, `internal`, or one of the confirmation codes the framework uses.

`ActionContext` is the second argument of `run`: `scope`, `source` (`"ui" | "agent" | "mcp" | "http"`), `principal`, `db` and `signal`.

Also exported: `asId` and the branded id types, `ANONYMOUS`, `isAuthenticated`, `userOf` and the principal types, `tableName`, `readTagsFor`, `writeTagsFor`, `tagsOverlap` (how reads and writes match), and `SHELL_ORIGINS` (the origins of the native shells).

## @parlor/core/registry

```ts
import { createRegistry } from "@parlor/core/registry";
//       ^?
```

Collects actions under their names. `ActionsOf<typeof registry>` is the action map type the client registers in `src/parlor.d.ts`.
