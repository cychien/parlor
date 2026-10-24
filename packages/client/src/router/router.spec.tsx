import { ActionError } from "@parlor/core";
import { encodeCursor } from "@parlor/sync";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  Link,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { actionQueryKey } from "../query-keys.js";
import { ensureActionQueryData } from "../react/action-query.js";
import { useActionSuspenseQuery } from "../react/hooks.js";
import { FrameworkProvider } from "../react/provider.js";
import type { SessionSnapshot, SessionSource } from "../session.js";
import { routeActionErrors } from "./errors.js";
import { createParlorRouter, type ParlorRouterContext } from "./router.js";

function syncStream() {
  const encoder = new TextEncoder();
  let push: (frame: string) => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (frame) => controller.enqueue(encoder.encode(frame));
      push('event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n');
    },
  });
  return {
    body,
    write: (tags: readonly (readonly string[])[], version: number) =>
      push(
        `data: ${JSON.stringify({
          events: [{ version, id: `e${version}`, tags }],
          cursor: encodeCursor({ version, id: `e${version}` }),
        })}\n\n`,
      ),
  };
}

function fakeServer() {
  const versions = new Map<string, number>();
  const stream = syncStream();
  const invoke = vi.fn(async (_name: string, input: { id: string }) => {
    if (input.id === "gone") throw new ActionError("not_found", "No task gone");
    if (input.id === "locked") throw new ActionError("unauthenticated", "Sign in first.");
    if (input.id === "secret") throw new ActionError("forbidden", "Not yours");
    const version = (versions.get(input.id) ?? 0) + 1;
    versions.set(input.id, version);
    return { data: { id: input.id, version }, tags: [["tasks", input.id]] };
  });
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/sync/token")) {
      return Response.json({
        protocol: 1,
        transport: "sse",
        endpoint: "/_parlor/sync/stream",
        pollIntervalMs: 60_000,
      });
    }
    if (path.includes("/sync/stream")) return new Response(stream.body);
    return Response.json({ events: [], cursor: "" });
  });
  const client = {
    clientId: "tab",
    basePath: "/_parlor",
    invoke,
    call: vi.fn(),
    request,
  };
  return {
    client: client as unknown as ActionClient<Record<string, never>> & typeof client,
    stream,
  };
}

function TaskPage() {
  const { taskId } = taskRoute.useParams();
  const task = useActionSuspenseQuery("getTask", { id: taskId }).data as {
    readonly id: string;
    readonly version: number;
  };
  return <output>{`${task.id} version:${task.version}`}</output>;
}

const rootRoute = createRootRouteWithContext<ParlorRouterContext>()({
  component: () => (
    <>
      <Link to="/tasks/$taskId" params={{ taskId: "42" }}>
        Open 42
      </Link>
      <Outlet />
    </>
  ),
});

const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  loader: ({ context, params }) =>
    ensureActionQueryData(context, "getTask", { id: params.taskId }),
  onError: routeActionErrors({ unauthenticated: () => redirect({ to: "/sign-in" }) }),
  component: TaskPage,
  pendingComponent: () => <p>pending</p>,
  notFoundComponent: () => <p>no such task</p>,
  errorComponent: ({ error }) => <p>failed: {(error as Error).message}</p>,
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => "home" }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/sign-in",
    component: () => "sign in",
  }),
  taskRoute,
]);

function mount(url: string, options: { readonly sync?: boolean } = {}) {
  const server = fakeServer();
  const queryClient = new QueryClient();
  const router = createParlorRouter({
    routeTree,
    client: server.client,
    queryClient,
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  render(
    <FrameworkProvider
      client={server.client}
      router={router}
      sync={options.sync ?? false}
    >
      <RouterProvider router={router} />
    </FrameworkProvider>,
  );
  const calls = () => server.client.invoke.mock.calls.length;
  return { ...server, queryClient, router, calls };
}

describe("route loaders", () => {
  it("render the page with the data the loader ensured, asking the server once", async () => {
    const { calls } = mount("/tasks/42");
    expect((await screen.findByRole("status")).textContent).toBe("42 version:1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls()).toBe(1);
  });

  it("preload on hover, so following the link answers from the cache", async () => {
    const { calls, router } = mount("/");
    await screen.findByText("home");

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Open 42" }));
    await waitFor(() => expect(calls()).toBe(1));

    fireEvent.click(screen.getByRole("link", { name: "Open 42" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/42"));
    expect(screen.queryByText("pending")).toBeNull();
    expect((await screen.findByRole("status")).textContent).toBe("42 version:1");
    expect(calls()).toBe(1);
  });

  it("seed the cache entry useActionQuery reads, so a sync event that writes what it read refetches it", async () => {
    const { calls, stream } = mount("/tasks/42", { sync: true });
    expect((await screen.findByRole("status")).textContent).toBe("42 version:1");

    act(() => stream.write([["tasks", "7"]], 2));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls()).toBe(1);

    act(() => stream.write([["tasks", "42"]], 3));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("42 version:2"),
    );
    expect(calls()).toBe(2);
  });

  it("share the router's queryClient with a FrameworkProvider given none, and its client", async () => {
    const { client, queryClient, router, calls } = mount("/tasks/42");
    await screen.findByRole("status");
    expect(router.options.context).toEqual({ client, queryClient });
    expect(queryClient.getQueryData(actionQueryKey("getTask", { id: "42" }))).toEqual({
      id: "42",
      version: 1,
    });
    expect(calls()).toBe(1);
  });

  it("run again as the new user when the signed-in user changes, redirecting on what they read", async () => {
    let user = "admin";
    const signedIn = (id: string): SessionSnapshot => ({
      status: "signed-in",
      user: { id, name: id, email: `${id}@example.com` },
    });
    let session = signedIn(user);
    const listeners = new Set<() => void>();
    const auth: SessionSource = {
      current: () => session,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const invoke = vi.fn(async () => ({ data: { admin: user === "admin" }, tags: [] }));
    const client = {
      clientId: "tab",
      basePath: "/_parlor",
      invoke,
      call: vi.fn(),
      request: vi.fn(),
    } as unknown as ActionClient<Record<string, never>>;
    const root = createRootRouteWithContext<ParlorRouterContext>()({ component: Outlet });
    const router = createParlorRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/", component: () => "home" }),
        createRoute({
          getParentRoute: () => root,
          path: "/admin",
          loader: async ({ context }) => {
            const me = (await ensureActionQueryData(context, "whoami", {})) as {
              readonly admin: boolean;
            };
            if (!me.admin) throw redirect({ to: "/" });
          },
          component: () => "admin area",
        }),
      ]),
      client,
      queryClient: new QueryClient(),
      history: createMemoryHistory({ initialEntries: ["/admin"] }),
    });
    render(
      <FrameworkProvider client={client} router={router} sync={false} auth={auth}>
        <RouterProvider router={router} />
      </FrameworkProvider>,
    );
    expect(await screen.findByText("admin area")).toBeTruthy();

    user = "bob";
    session = signedIn(user);
    act(() => listeners.forEach((listener) => listener()));
    expect(await screen.findByText("home")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("routeActionErrors in a route", () => {
  it("turns not_found into the route's notFoundComponent", async () => {
    mount("/tasks/gone");
    expect(await screen.findByText("no such task")).toBeTruthy();
  });

  it("turns a code it names into that redirect", async () => {
    const { router } = mount("/tasks/locked");
    expect(await screen.findByText("sign in")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("leaves a code it does not name to the errorComponent", async () => {
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mount("/tasks/secret");
    expect((await screen.findByText(/^failed:/)).textContent).toBe("failed: Not yours");
  });
});

describe("createParlorRouter", () => {
  it("preloads on intent and leaves staleness to TanStack Query, unless told otherwise", () => {
    const { client } = fakeServer();
    const queryClient = new QueryClient();
    const defaults = createParlorRouter({ routeTree, client, queryClient });
    expect(defaults.options.defaultPreload).toBe("intent");
    expect(defaults.options.defaultPreloadStaleTime).toBe(0);

    const tuned = createParlorRouter({
      routeTree,
      client,
      queryClient,
      defaultPreload: false,
      context: {},
    });
    expect(tuned.options.defaultPreload).toBe(false);
    expect(tuned.options.context).toEqual({ client, queryClient });
  });

  it("makes a QueryClient of its own when given none", () => {
    const { client } = fakeServer();
    const router = createParlorRouter({ routeTree, client });
    expect(router.options.context.queryClient).toBeInstanceOf(QueryClient);
    expect(router.options.context.client).toBe(client);
  });
});
