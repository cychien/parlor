import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { actionQueryOptions } from "./action-query.js";
import { useActionQuery } from "./hooks.js";
import { FrameworkProvider } from "./provider.js";

const written = (version: number, id: string) => ({
  version,
  id,
  tags: [["tasks", id]],
});

function serverWith(log: ReturnType<typeof written>[], resetTo?: string) {
  const streams: string[] = [];
  const invoke = vi.fn(async () => ({
    data: { tasks: log.length },
    tags: [["tasks"]],
    cursor: "41.e",
  }));
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/sync/token")) {
      return Response.json({
        protocol: 1,
        transport: "sse",
        endpoint: "/_parlor/sync/stream",
        pollIntervalMs: 2000,
      });
    }
    const since = new URL(path, "http://app.test").searchParams.get("since") ?? "";
    streams.push(since);
    const [version = 0, id = ""] = since === "" ? [] : since.split(".");
    const missed = log.filter(
      (event) =>
        event.version > Number(version) ||
        (event.version === Number(version) && event.id > id),
    );
    const frames = ['event: handshake\ndata: {"protocol":1,"capabilities":[]}\n\n'];
    if (resetTo !== undefined) {
      frames.push(
        `data: ${JSON.stringify({ events: [], cursor: resetTo, reset: true })}\n\n`,
      );
    } else if (missed.length > 0) {
      const last = missed.at(-1)!;
      frames.push(
        `data: ${JSON.stringify({ events: missed, cursor: `${last.version}.${last.id}` })}\n\n`,
      );
    }
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
        },
      }),
      { status: 200 },
    );
  });
  const client = {
    clientId: "tab",
    basePath: "/_parlor",
    invoke,
    call: vi.fn(),
    request,
  } as unknown as ActionClient<Record<string, never>>;
  return { client, invoke, streams };
}

function Tasks() {
  const query = useActionQuery("listTasks", {});
  return <output>{query.data ? "loaded" : "loading"}</output>;
}

async function loadThenConnect(log: ReturnType<typeof written>[], resetTo?: string) {
  const server = serverWith(log, resetTo);
  const queryClient = new QueryClient();
  await queryClient.fetchQuery(
    actionQueryOptions({ client: server.client, queryClient }, "listTasks", {}),
  );
  const view = render(
    <FrameworkProvider client={server.client} queryClient={queryClient}>
      <Tasks />
    </FrameworkProvider>,
  );
  await waitFor(() => expect(server.streams).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { ...server, view };
}

describe("the sync stream of a page that already holds data", () => {
  it("starts where the data stands, so writes the data shows refetch nothing", async () => {
    const { invoke, streams, view } = await loadThenConnect([
      written(40, "a"),
      written(41, "e"),
    ]);
    expect(streams).toEqual(["41.e"]);
    expect(screen.getByRole("status").textContent).toBe("loaded");
    expect(invoke).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("still refetches for a write made between the load and the connect", async () => {
    const { invoke, streams, view } = await loadThenConnect([
      written(40, "a"),
      written(41, "e"),
      written(42, "f"),
    ]);
    expect(streams).toEqual(["41.e"]);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    view.unmount();
  });
});

describe("a sync stream the server resets", () => {
  it("refetches data older than where the reset leaves the stream", async () => {
    const { invoke, view } = await loadThenConnect([written(41, "e")], "90.z");
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    view.unmount();
  });

  it("keeps data that already reflects where the reset leaves the stream", async () => {
    const { invoke, view } = await loadThenConnect([written(41, "e")], "41.e");
    expect(invoke).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
