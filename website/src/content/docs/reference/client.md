---
title: "@parlor/client"
description: The action client, the action Register, and agent views.
---

```sh
pnpm add @parlor/client @tanstack/react-query @tanstack/react-router
```

```ts
import { createActionClient } from "@parlor/client";
//       ^?
```

The browser's only way to reach the server. Without options it calls the page's own origin, or `server.url` in a native shell. `headers` adds headers to every call (the auth client's session); `baseUrl` and `fetch` point it elsewhere, for example at `server.fetch` in tests.

`client.call(name, input)` returns an action's data; `client.invoke(name, input)` returns `{ data, tags }`.

## Register

Augment `Register` once so names and inputs are typed everywhere:

```ts
// @filename: actions.ts
import { createRegistry } from "@parlor/core/registry";
export const registry = createRegistry({});
// @filename: parlor.ts
import "@parlor/client";
// ---cut---
import type { ActionsOf } from "@parlor/core/registry";

import type { registry } from "./actions.js";

declare module "@parlor/client" {
  interface Register {
    actions: ActionsOf<typeof registry>;
  }
}
```

## Agent views

```ts
import { defineAgentView } from "@parlor/client";
//       ^?
```

Describes a piece of UI the agent can read; bind it with `useAgentView` from [`@parlor/client/react`](/reference/client-react/).

Also exported: `appOrigin`, `generateClientId`, `createPluginClient` (a typed client for a plugin's actions), and the session interfaces an auth client implements (`SessionSource`, `SessionSnapshot`, `FrameworkAuth`).
