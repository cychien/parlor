---
title: Pages and hooks
description: File-based routes, and the hooks that call actions from React.
---

The web app is one React app with TanStack Router file routes. Every file in `src/routes/` is a page; `src/routes/__root.tsx` is the shell around them. `parlor dev`, `parlor build` and `parlor typegen` regenerate `src/routeTree.gen.ts` from that folder, so routes stay typed. Commit the generated file.

`parlor build` puts each page's components in a chunk of their own, so the first load carries only the pages it shows; the rest load when a link to them is hovered or followed.

## Type the actions once

`src/parlor.d.ts` tells the client which actions exist, so hook names and inputs are checked:

```ts
// @filename: actions/index.ts
import { createRegistry } from "@parlor/core/registry";
export const registry = createRegistry({});
// @filename: src/parlor.d.ts
// ---cut---
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
// @filename: actions/index.ts
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

export const registry = createRegistry({
  listNotes: defineAction({
    description: "List the notes.",
    input: z.object({}),
    reads: ["notes"],
    run: () => [{ id: "1", body: "Hello" }],
  }),
  addNote: defineAction({
    description: "Add a note.",
    input: z.object({ body: z.string() }),
    writes: ["notes"],
    run: ({ body }) => ({ id: "2", body }),
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
// @filename: notes.tsx
// ---cut---
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

You never refetch by hand. When any caller runs an action that `writes` what a query `reads`, the query refetches, in this tab and in every other one. Only writes newer than the query's data count: each read answers with how far into the sync log its data reaches, so a page that loads right after some writes, or reconnects, does not refetch for writes its data already shows.

Until then the data counts as fresh: mounting another component that reads it, focusing the window, reconnecting and hydrating a page the server rendered all use it as it is. To refetch on TanStack Query's own schedule instead, pass `staleTime` to the hook, or give your `QueryClient` a `staleTime` default.

## Load a page's data in its loader

A route's `loader` can fetch what the page reads before the page renders, so it appears with its data instead of a loading state, and links fetch it while the pointer rests on them. `ensureActionQueryData(context, name, input)` loads an action into the same cache entry `useActionQuery` reads, and `useActionSuspenseQuery` reads it back with `data` always set:

```tsx
// @filename: actions/index.ts
import { ActionError, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

export const registry = createRegistry({
  getNote: defineAction({
    description: "Get one note by id.",
    input: z.object({ id: z.string() }),
    reads: ({ id }) => [["notes", id]],
    run: ({ id }) => {
      if (id !== "1") throw new ActionError("not_found", `No note ${id}`);
      return { id, body: "Hello", archived: false };
    },
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
// @filename: src/routes/notes.$noteId.tsx
import type { ParlorRouterContext } from "@parlor/client/router";
import { createRootRouteWithContext } from "@tanstack/react-router";
const rootRoute = createRootRouteWithContext<ParlorRouterContext>()({});
declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/notes/$noteId": {
      id: "/notes/$noteId";
      path: "/notes/$noteId";
      fullPath: "/notes/$noteId";
      preLoaderRoute: typeof Route;
      parentRoute: typeof rootRoute;
    };
  }
}
// ---cut---
import { ensureActionQueryData, useActionSuspenseQuery } from "@parlor/client/react";
import { routeActionErrors } from "@parlor/client/router";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/notes/$noteId")({
  loader: ({ context, params }) =>
    ensureActionQueryData(context, "getNote", { id: params.noteId }),
  onError: routeActionErrors({
    unauthenticated: () => redirect({ to: "/sign-in" }),
  }),
  notFoundComponent: () => <p>No such note.</p>,
  component: Note,
});

function Note() {
  const { noteId } = Route.useParams();
  const { data: note } = useActionSuspenseQuery("getNote", { id: noteId });
  return <p>{note.body}</p>;
}
```

- The loader's data stays fresh like any query's: a write to what it read refetches it, in every tab. A loader returns cached data at once, and fetches first only when there is none or a write has made it out of date.
- Read loader data with `useActionSuspenseQuery`. `useActionQuery` also finds it, but asks the server again when it mounts.
- `routeActionErrors(routes)` turns an `ActionError` into the route's control flow: `not_found` becomes `notFound()`, which renders the route's `notFoundComponent`, and each code you name becomes what its function returns, usually a `redirect(...)`. Any other error reaches the route's `errorComponent`. Pass it as `onError`, or to `.catch` inside a loader.
- A loader may decide a redirect from the data, for example to an item's canonical address. Throw `redirect(...)` after awaiting the data:

```ts
// @filename: actions/index.ts
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

export const registry = createRegistry({
  getNote: defineAction({
    description: "Get one note by id.",
    input: z.object({ id: z.string() }),
    run: ({ id }) => ({ id, body: "Hello", archived: false }),
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
// @filename: loader.ts
import type { ParlorRouterContext } from "@parlor/client/router";
declare const context: ParlorRouterContext;
declare const params: { noteId: string };
// ---cut---
import { ensureActionQueryData } from "@parlor/client/react";
import { routeActionErrors } from "@parlor/client/router";
import { redirect } from "@tanstack/react-router";

export async function loader() {
  const note = await ensureActionQueryData(context, "getNote", {
    id: params.noteId,
  }).catch(routeActionErrors());
  if (note.archived) throw redirect({ to: "/" });
}
```

Use `beforeLoad` only for checks that need no data, and fetch in `loader`: `beforeLoad` runs again on every navigation, while the loader's data is cached. A loader runs again as the new user when the signed-in user changes.

`actionQueryOptions(context, name, input)` is the query behind all of these, for `queryClient.prefetchQuery` (load without waiting) or `useQueries`.

## The provider

`src/main.tsx` creates the action client, the router with `createParlorRouter`, wraps the router in `FrameworkProvider`, and starts the app with `mount`:

```tsx
// @filename: routeTree.gen.ts
import type { ParlorRouterContext } from "@parlor/client/router";
import { createRootRouteWithContext } from "@tanstack/react-router";
export const routeTree = createRootRouteWithContext<ParlorRouterContext>()();
// @filename: main.tsx
// ---cut---
import { createActionClient } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { createParlorRouter, mount } from "@parlor/client/router";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";

import { routeTree } from "./routeTree.gen.js";

const client = createActionClient();
const router = createParlorRouter({ routeTree, client });

mount(document.getElementById("root")!, {
  router,
  element: (
    <StrictMode>
      <FrameworkProvider client={client} router={router}>
        <RouterProvider router={router} />
      </FrameworkProvider>
    </StrictMode>
  ),
});
```

`mount` renders the app into the element, or hydrates it when the server rendered the page there; see [Server rendering](/parlor/guides/server-rendering/).

`createParlorRouter` is TanStack Router's `createRouter` with `client` and a TanStack Query `queryClient` in every loader's `context`, links that preload on hover, and `defaultPreloadStaleTime: 0`, so TanStack Query alone decides when data is stale. It takes every `createRouter` option, and `context` for more of your own. `FrameworkProvider` uses the router's `queryClient`, so loaders and hooks share one cache. Type the root route's context with `createRootRouteWithContext<ParlorRouterContext>()` in `src/routes/__root.tsx`.

Never call `fetch` for app data: the action client carries the session, the caller's identity and the sync that keeps pages fresh.

## Tell agents what a page is

Each route can describe itself for the agent:

```tsx
// @filename: src/routes/index.tsx
import { createRootRoute } from "@tanstack/react-router";
const rootRoute = createRootRoute();
declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/": {
      id: "/";
      path: "/";
      fullPath: "/";
      preLoaderRoute: typeof Route;
      parentRoute: typeof rootRoute;
    };
  }
}
// ---cut---
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: { description: "The note list: add a note or delete one." },
  component: () => null,
});
```

The sidebar's agent receives the current page's description, so "delete the second one" has a referent. Agents also get every page's path, description, `$params` and the search params its `validateSearch` schema takes, so they can open any page with `ui_navigate`. See [The agent sidebar](/parlor/guides/agent-sidebar/).
