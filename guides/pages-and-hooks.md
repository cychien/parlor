# Pages and hooks

The web app is one React app with TanStack Router file routes. Every file in `src/routes/` is a page; `src/routes/__root.tsx` is the shell around them. `parlor dev`, `parlor build` and `parlor typegen` regenerate `src/routeTree.gen.ts` from that folder, so routes stay typed. Commit the generated file.

## Type the actions once

`src/parlor.d.ts` tells the client which actions exist, so hook names and inputs are checked:

```ts
import type { ActionsOf } from "@parlor/core/registry";

import type { registry } from "../actions/index.js";

declare module "@parlor/client" {
  interface Register {
    actions: ActionsOf<typeof registry>;
  }
}
```

## Read with useActionQuery

```tsx
import { useActionMutation, useActionQuery } from "@parlor/client/react";

export function Notes() {
  const notes = useActionQuery("listNotes", {});
  const add = useActionMutation("addNote");
  return (
    <section>
      <ul>
        {notes.data?.map((note) => (
          <li key={note.id}>{note.body}</li>
        ))}
      </ul>
      <button type="button" onClick={() => add.mutate({ body: "New note" })}>
        Add
      </button>
    </section>
  );
}
```

`useActionQuery(name, input, options?)` is a TanStack Query `useQuery` whose data is the action's return value. `useActionMutation(name, options?)` is a `useMutation`. Both accept the usual TanStack Query options.

You never refetch by hand. When any caller runs an action that `writes` what a query `reads`, the query refetches, in this tab and in every other one.

## The provider

`src/main.tsx` creates the action client and wraps the router in `FrameworkProvider`:

```tsx
import { createActionClient } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { routeTree } from "./routeTree.gen.js";

const client = createActionClient();
const router = createRouter({ routeTree });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FrameworkProvider client={client} router={router}>
      <RouterProvider router={router} />
    </FrameworkProvider>
  </StrictMode>,
);
```

Never call `fetch` for app data: the action client carries the session, the caller's identity and the sync that keeps pages fresh.

## Tell agents what a page is

Each route can describe itself for the agent:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: { description: "The note list: add a note or delete one." },
  component: () => null,
});
```

The sidebar's agent receives the current page's description, so "delete the second one" has a referent. Agents also get every page's path, description, `$params` and the search params its `validateSearch` schema takes, so they can open any page with `ui_navigate`. See [The agent sidebar](/parlor/guides/agent-sidebar/).
