import { vi } from "vitest";

import type { ActionClient } from "../../action-client.js";

export function sse(frames: string[], later: string[] = []) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      timer = setTimeout(() => {
        for (const frame of later) controller.enqueue(encoder.encode(frame));
      }, 100);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
}

export function agentRequest(id: string, op = "screen", input: unknown = {}) {
  return JSON.stringify({
    id,
    op,
    input,
    origin: { via: "mcp" },
    timeoutMs: 5000,
  });
}

export function fakeClient(
  options: {
    delayRequest?: boolean;
    next?: Record<string, string>;
    request?: string;
  } = {},
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
              : [`event: ui\ndata: ${options.request ?? agentRequest("r1")}\n\n`]),
          ],
          options.delayRequest
            ? [`event: ui\ndata: ${options.request ?? agentRequest("r1")}\n\n`]
            : [],
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
