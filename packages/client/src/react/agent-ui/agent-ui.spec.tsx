import { defineAgentView } from "@parlor/agent-ui";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ActionClient } from "../../action-client.js";
import { useActionQuery } from "../hooks.js";
import { FrameworkProvider } from "../provider.js";
import { useAgentActivity } from "./use-agent-activity.js";
import { useAgentView } from "./use-agent-view.js";

const greeting = defineAgentView({
  name: "greeting",
  description: "The name being greeted.",
  schema: z.object({ name: z.string() }),
});

function sse(frames: string[], later: string[] = []) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      setTimeout(() => {
        for (const frame of later) controller.enqueue(encoder.encode(frame));
      }, 100);
    },
  });
}

function agentRequest(id: string) {
  return JSON.stringify({
    id,
    op: "screen",
    input: {},
    origin: { via: "mcp" },
    timeoutMs: 5000,
  });
}

function fakeClient(
  options: { delayRequest?: boolean; next?: Record<string, string> } = {},
) {
  const posts: unknown[] = [];
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/sync/token")) {
      return Response.json({
        protocol: 1,
        transport: "sse",
        endpoint: "/_parlor/sync/stream",
        pollIntervalMs: 2000,
      });
    }
    if (path.includes("/sync/stream")) {
      return new Response(
        sse(
          [
            'event: handshake\ndata: {"protocol":1,"capabilities":["ui"]}\n\n',
            ...(options.delayRequest
              ? []
              : [`event: ui\ndata: ${agentRequest("r1")}\n\n`]),
          ],
          options.delayRequest ? [`event: ui\ndata: ${agentRequest("r1")}\n\n`] : [],
        ),
      );
    }
    if (path.endsWith("/ui")) {
      const message = JSON.parse(String(init?.body)) as { type: string; id?: string };
      posts.push(message);
      const next =
        message.type === "reply" ? options.next?.[message.id ?? ""] : undefined;
      return next === undefined
        ? new Response(null, { status: 204 })
        : new Response(next, { headers: { "content-type": "application/json" } });
    }
    return Response.json({ events: [], cursor: "" });
  });
  const client = {
    clientId: "tab-1",
    basePath: "/_parlor",
    request,
    invoke: vi.fn(async (name: string) => {
      if (name === "loaded") return { data: { ok: true }, tags: [] };
      if (name === "broken") throw new Error("boom");
      return new Promise(() => {});
    }),
    call: vi.fn(),
  };
  return { client: client as unknown as ActionClient<Record<string, never>>, posts };
}

function Greeting() {
  const [name] = useState("Ada");
  const { ref } = useAgentView(greeting, { get: () => ({ name }) });
  const { busy, last } = useAgentActivity();
  return (
    <section ref={ref}>
      <p>Hello {name}</p>
      <output>
        {busy ? `agent ${last?.op}` : last ? `agent did ${last.op}` : "idle"}
      </output>
    </section>
  );
}

describe("agent UI in FrameworkProvider", () => {
  it("answers an agent request over the sync channel with the bound views", async () => {
    const { client, posts } = fakeClient();
    render(
      <StrictMode>
        <FrameworkProvider
          client={client}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Greeting />
        </FrameworkProvider>
      </StrictMode>,
    );
    await waitFor(() =>
      expect(posts).toContainEqual(
        expect.objectContaining({ type: "reply", id: "r1", ok: true }),
      ),
    );
    const reply = posts.find((p) => (p as { type: string }).type === "reply") as {
      result: { views: Record<string, unknown> };
    };
    expect(reply.result.views).toEqual({
      greeting: { value: { name: "Ada" }, shown: 0 },
    });
    expect(posts).toContainEqual({
      type: "presence",
      focused: expect.any(Boolean),
      visible: true,
      platform: "web",
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("agent did screen"),
    );
  });

  it("answers the request the server hands back in response to a reply", async () => {
    const { client, posts } = fakeClient({ next: { r1: agentRequest("r2") } });
    render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Greeting />
      </FrameworkProvider>,
    );
    await waitFor(() =>
      expect(
        posts
          .filter((p) => (p as { type: string }).type === "reply")
          .map((p) => (p as { id: string }).id),
      ).toEqual(["r1", "r2"]),
    );
  });

  it("reports each active query's status so loading and failed data read as such", async () => {
    const { client, posts } = fakeClient({ delayRequest: true });
    render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Queries />
      </FrameworkProvider>,
    );
    await waitFor(() =>
      expect(posts).toContainEqual(expect.objectContaining({ type: "reply", id: "r1" })),
    );
    const reply = posts.find((p) => (p as { type: string }).type === "reply") as {
      result: { queries: unknown[] };
    };
    expect(reply.result.queries).toEqual([
      { action: "loaded", input: {}, status: "success" },
      { action: "broken", input: {}, status: "error" },
      { action: "waiting", input: {}, status: "pending" },
    ]);
  });
});

function Queries() {
  useActionQuery("loaded" as never, {} as never);
  useActionQuery("broken" as never, {} as never);
  useActionQuery("waiting" as never, {} as never);
  return null;
}

async function routeAt(url: string) {
  const root = createRootRoute({ component: Outlet });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/", component: () => "Home" }),
    createRoute({
      getParentRoute: () => root,
      path: "/tasks/$taskId",
      component: () => "Task",
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  const { client, posts } = fakeClient({ delayRequest: true });
  render(
    <FrameworkProvider
      client={client}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      router={router}
    >
      <RouterProvider router={router} />
    </FrameworkProvider>,
  );
  await waitFor(() =>
    expect(posts).toContainEqual(expect.objectContaining({ type: "reply", id: "r1" })),
  );
  const reply = posts.find((p) => (p as { type: string }).type === "reply") as {
    result: { route: unknown };
  };
  return reply.result.route;
}

describe("agent UI route", () => {
  it("reports the matched route's pattern, params, search and url", async () => {
    expect(await routeAt("/tasks/t1?tab=notes")).toEqual({
      notFound: false,
      path: "/tasks/$taskId",
      params: { taskId: "t1" },
      search: { tab: "notes" },
      url: "/tasks/t1?tab=notes",
    });
  });

  it("reports a location no route matches as not found and keeps its url", async () => {
    const route = await routeAt("/bogus");
    expect(screen.getByText("Not Found")).toBeTruthy();
    expect(route).toEqual({ notFound: true, url: "/bogus" });
  });
});
