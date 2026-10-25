---
title: Server rendering
description: Render public pages on the server on web, with their data, title and share card in the HTML.
---

A page normally reaches the browser as an empty `index.html` that fills in once the JavaScript runs. A public page that search engines index or people share, such as a home or sales page, needs its content, `<title>` and Open Graph tags in the HTML itself. Turn on server rendering for those routes: on web, the server runs their loaders and sends the rendered page, and the browser picks it up from there.

It is progressive. A route that does not opt in, every route in the desktop and mobile apps, and any page whose server render fails get `index.html` as before, and render in the browser.

## Turn it on

The server builds the app once per page it renders, so the app needs to be a function. Move what `src/main.tsx` builds into a module whose default export takes the action client and returns the router and the element:

```tsx
// @filename: routeTree.gen.ts
import type { ParlorRouterContext } from "@parlor/client/router";
import { createRootRouteWithContext } from "@tanstack/react-router";
export const routeTree = createRootRouteWithContext<ParlorRouterContext>()();
// @filename: app.tsx
// ---cut---
import type { ActionClient, RegisteredActions } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { createParlorRouter } from "@parlor/client/router";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";

import { routeTree } from "./routeTree.gen.js";

export default function createApp(client: ActionClient<RegisteredActions>) {
  const router = createParlorRouter({ routeTree, client });
  return {
    router,
    element: (
      <StrictMode>
        <FrameworkProvider client={client} router={router}>
          <RouterProvider router={router} />
        </FrameworkProvider>
      </StrictMode>
    ),
  };
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createApp>["router"];
  }
}
```

`src/main.tsx` builds it with the browser's client and starts it with `mount`, which hydrates a page the server rendered and renders any other from scratch:

```tsx
// @filename: app.tsx
import type { ActionClient, RegisteredActions } from "@parlor/client";
import type { ParlorApp } from "@parlor/client/router";
export default function createApp(client: ActionClient<RegisteredActions>): ParlorApp {
  return { router: null!, element: null };
}
// @filename: main.tsx
// ---cut---
import { createActionClient } from "@parlor/client";
import { mount } from "@parlor/client/router";

import createApp from "./app.js";

mount(document.getElementById("root")!, createApp(createActionClient()));
```

Name the module in `parlor.config.ts`:

```ts
import { defineConfig } from "@parlor/config";

export default defineConfig({
  app: { id: "com.example.shop", name: "Shop" },
  web: { ssr: { app: "src/app.tsx" } },
});
```

The page renders into the element with `id="root"` in `index.html`, as the template has it.

## Opt routes in

A page renders on the server only when every route it matches sets TanStack Router's `ssr: true`, the root route included. Put the page's `<title>` and meta tags in `head()`, and render `<HeadContent />` in the root route so they reach the HTML:

```tsx
// @filename: actions/index.ts
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";
export const registry = createRegistry({
  getCourse: defineAction({
    description: "One course.",
    input: z.object({ id: z.string() }),
    reads: ["courses"],
    run: ({ id }) => ({ id, title: "Pottery", summary: "Throw a bowl." }),
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
// @filename: routes.tsx
import "./register.js";
// ---cut---
import { ensureActionQueryData, useActionSuspenseQuery } from "@parlor/client/react";
import type { ParlorRouterContext } from "@parlor/client/router";
import {
  createRootRouteWithContext,
  createRoute,
  HeadContent,
  Outlet,
} from "@tanstack/react-router";

export const rootRoute = createRootRouteWithContext<ParlorRouterContext>()({
  ssr: true,
  head: () => ({ meta: [{ property: "og:site_name", content: "Shop" }] }),
  component: () => (
    <>
      <HeadContent />
      <Outlet />
    </>
  ),
});

export const courseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$courseId",
  ssr: true,
  loader: ({ context, params }) =>
    ensureActionQueryData(context, "getCourse", { id: params.courseId }),
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.title },
      { property: "og:title", content: loaderData?.title },
      { property: "og:description", content: loaderData?.summary },
    ],
  }),
  component: Course,
});

function Course() {
  const { courseId } = courseRoute.useParams();
  const { data: course } = useActionSuspenseQuery("getCourse", { id: courseId });
  return <h1>{course.title}</h1>;
}
```

With file routes, add `ssr: true` to `createRootRouteWithContext` in `src/routes/__root.tsx` and to each page's `createFileRoute`. Routes without it, such as an admin area, keep rendering in the browser.

## What the server does

For a browser's request for an opted-in page, the server:

1. Runs the matched routes' loaders. Their actions run against the app's server in the same deployment, with the page request's `cookie` and `authorization` headers, so they see the same signed-in user as the browser.
2. Answers a loader's `redirect(...)` with a redirect, and `notFound()` with the route's not-found page and status 404.
3. Renders the page into `index.html`, with `head()`'s tags in `<head>`, and sends the router's state and the query cache along. The browser starts with that cache, so `useActionSuspenseQuery` has its data at once without asking the server again, however long the page took to arrive, and sync keeps it fresh as it does any other query.

Other headers the browser's action client adds do not reach the server render. Anything a server-rendered page's actions need, such as a pass to a private area, belongs in a cookie.

The response carries a `Content-Security-Policy` whose `script-src` allows a new nonce for each response, and every inline script of the page carries it. It is sent with `Cache-Control: private, no-cache`, since a signed-in visitor's page holds their data; a route can set its own with TanStack Router's `headers()`.

Pages that do not render on the server, unknown paths and every other request work as before. With `web.ssr` set, the service worker no longer answers navigations with a cached `index.html`, so every page comes from the server.

## Write components that render on the server

A server-rendered component runs once in Node or in a Cloudflare Worker, then again in the browser, which must render the same markup.

- Do not read `window`, `document`, `localStorage` or `navigator` while rendering. Read them in `useEffect`, or render the browser-only part once `useHydrated()` from `@tanstack/react-router` is true, for example a portal into `document.body`.
- Do not render values that differ between the two, such as the current time or a random number, without passing them through the loader.
- `useSession()` is `loading` on the server and while the page hydrates. Redirect a signed-out visitor in a loader with `routeActionErrors`, not while rendering.
- Modules a page imports must not draw random values, set timers or do I/O when they load: Cloudflare Workers forbid it, as they do for `server.ts`.

If rendering throws, the server logs it and sends `index.html`, so the page still works.

## In development

`parlor dev` renders opted-in pages on the server too, so what you see is what the build serves. It runs the app's own code through Vite, with changes picked up on the next request. Its policy keeps allowing inline scripts for Vite's hot reload. The desktop and mobile dev servers do not render on the server, matching their builds.
