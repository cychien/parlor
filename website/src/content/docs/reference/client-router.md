---
title: "@parlor/client/router"
description: createParlorRouter, the router context loaders read, routeActionErrors, and mount.
---

TanStack Router integration for route loaders. The reads themselves, `ensureActionQueryData` and `useActionSuspenseQuery`, are in [`@parlor/client/react`](/parlor/reference/client-react/). See [Load a page's data in its loader](/parlor/guides/pages-and-hooks/#load-a-pages-data-in-its-loader).

```ts
import { createParlorRouter } from "@parlor/client/router";
//       ^?
```

`createRouter` with `{ client, queryClient }` in every loader's `context`, `defaultPreload: "intent"`, `defaultPreloadStaleTime: 0` and `defaultSsr: false`, so a route renders on the server only with `ssr: true`. It takes every `createRouter` option; yours win. `queryClient` defaults to a new `QueryClient`, and `context` adds your own fields next to Parlor's. A server render carries the query cache and its read tags to the browser through the router's `dehydrate` and `hydrate`; yours run next to it.

```ts
import type { ParlorRouterContext } from "@parlor/client/router";
//            ^?
```

The router context: `createRootRouteWithContext<ParlorRouterContext>()` in `src/routes/__root.tsx` types `context` in every `beforeLoad` and `loader`. Intersect it with your own type for more fields.

```ts
import { routeActionErrors } from "@parlor/client/router";
//       ^?
```

Returns a function that rethrows an `ActionError` as router control flow: `not_found` as `notFound()`, each code you name as what its function returns (`redirect(...)` or `notFound(...)`), and anything else unchanged for the route's `errorComponent`. Use it as a route's `onError`, or with `.catch` in a loader.

```ts
// @filename: errors.ts
// ---cut---
import { routeActionErrors } from "@parlor/client/router";
import { redirect } from "@tanstack/react-router";

export const routeErrors = routeActionErrors({
  unauthenticated: () => redirect({ to: "/sign-in" }),
  forbidden: () => redirect({ to: "/" }),
});
```

```ts
import { mount } from "@parlor/client/router";
//       ^?
```

Starts the app in the element: it hydrates a page the server rendered there, and renders from scratch otherwise, as for a page that does not render on the server and in the desktop and mobile apps. See [Server rendering](/parlor/guides/server-rendering/).

```ts
import type { CreateParlorApp, ParlorApp } from "@parlor/client/router";
//            ^?
```

`ParlorApp` is what `mount` takes: the router and the element that renders it. `CreateParlorApp` is the default export of the module `web.ssr.app` names, which builds a `ParlorApp` around an action client.
