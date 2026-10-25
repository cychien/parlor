import type { ActionMap } from "@parlor/core";
import {
  createRootRouteWithContext,
  createRoute,
  HeadContent,
  notFound,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode, useId } from "react";
import { vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { ensureActionQueryData } from "../react/action-query.js";
import { useActionSuspenseQuery } from "../react/hooks.js";
import { FrameworkProvider } from "../react/provider.js";
import { createParlorRouter, type ParlorRouterContext } from "../router/router.js";
import { createRenderer } from "./render.js";

export const TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>App</title><link rel="stylesheet" href="/app.css" /></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`;

interface Task {
  readonly id: string;
  readonly title: string;
}

const rootRoute = createRootRouteWithContext<ParlorRouterContext>()({
  ssr: true,
  head: () => ({ meta: [{ property: "og:site_name", content: "Tasks" }] }),
  component: Shell,
});

function Shell() {
  const label = useId();
  return (
    <>
      <HeadContent />
      <nav aria-labelledby={label}>
        <span id={label}>Tasks app</span>
      </nav>
      <Outlet />
    </>
  );
}

function TaskPage() {
  const { taskId } = taskRoute.useParams();
  const task = useActionSuspenseQuery("getTask", { id: taskId }).data as Task;
  return <h1>{task.title}</h1>;
}

const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  ssr: true,
  loader: async ({ context, params }) => {
    if (params.taskId === "old")
      throw redirect({ to: "/tasks/$taskId", params: { taskId: "1" } });
    if (params.taskId === "gone") throw notFound();
    return (await ensureActionQueryData(context, "getTask", {
      id: params.taskId,
    })) as Task;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.title} · Tasks` },
      { property: "og:title", content: loaderData?.title },
    ],
  }),
  component: TaskPage,
  notFoundComponent: () => <p>No such task</p>,
});

const routeTree = rootRoute.addChildren([
  taskRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    loader: ({ context }) => ensureActionQueryData(context, "getTask", { id: "1" }),
    component: () => <p>settings</p>,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/maybe",
    ssr: () => false,
    component: () => <p>maybe</p>,
  }),
]);

export interface Received {
  readonly path: string;
  readonly headers: Headers;
}

export function appServer() {
  const received: Received[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const { pathname } = new URL(request.url);
    received.push({ path: pathname, headers: request.headers });
    const { id } = (await request.json()) as { id: string };
    return Response.json({
      data: { id, title: `Task ${id}` },
      tags: [["tasks", id]],
      cursor: "41.e",
    });
  });
  return { fetch, received };
}

export function createApp(client: ActionClient<ActionMap>, isServer: boolean) {
  const router = createParlorRouter({ routeTree, client, isServer });
  return {
    router,
    element: (
      <StrictMode>
        <FrameworkProvider client={client} router={router} sync={false}>
          <RouterProvider router={router} />
        </FrameworkProvider>
      </StrictMode>
    ),
  };
}

export const render = createRenderer((client) => createApp(client, true));

export function page(path: string, headers: HeadersInit = {}) {
  return new Request(`https://tasks.example${path}`, {
    headers: { accept: "text/html", ...headers },
  });
}
