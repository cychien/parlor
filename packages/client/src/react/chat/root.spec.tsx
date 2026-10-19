import type { LoggedItem, OpenTurn } from "@parlor/chat";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../../action-client.js";
import * as Chat from "../agent-ui/chat.js";
import { FrameworkProvider } from "../provider.js";
import { useChat } from "./use-chat.js";

vi.mock("@parlor/chat", () => ({
  CHAT_CHANNEL: "chat",
  parseChatFrame: (data: string) => JSON.parse(data),
  foldThread: (input: { items: readonly LoggedItem[]; open: readonly OpenTurn[] }) => [
    ...input.items.map((item) => ({ kind: item.kind, id: item.id, streaming: false })),
    ...input.open.flatMap((turn) =>
      turn.items.map((item) => ({
        kind: item.kind,
        id: item.id,
        streaming: true,
        text: "text" in item ? item.text : "",
      })),
    ),
  ],
}));

const snapshot = {
  threads: [],
  hosts: [
    {
      id: "host_mac",
      name: "Alice's Mac",
      platform: "macos",
      online: true,
      agents: [{ id: "claude", name: "Claude Code", ready: true }],
    },
  ],
  page: {
    thread: { id: "thr_1", title: "t", updatedAt: 1, lastSeq: 0 },
    items: [],
    open: [
      {
        turnId: "turn_1",
        threadId: "thr_1",
        items: [{ id: "turn_1.1", kind: "reply", text: "Hel" }],
      },
    ],
    turns: [
      {
        turnId: "turn_1",
        state: "running",
        agent: { hostId: "host_mac", agentId: "claude" },
      },
    ],
    hasMore: false,
  },
};

function fakeClient(options: { chat: boolean; streamFrames?: string[] }) {
  const encoder = new TextEncoder();
  const posts: string[] = [];
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
      const capabilities = options.chat ? ["ui", "chat"] : ["ui"];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: handshake\ndata: ${JSON.stringify({ protocol: 1, capabilities })}\n\n`,
              ),
            );
            setTimeout(() => {
              for (const frame of options.streamFrames ?? []) {
                controller.enqueue(encoder.encode(`event: chat\ndata: ${frame}\n\n`));
              }
            }, 150);
          },
        }),
      );
    }
    if (path.endsWith("/ui")) return new Response(null, { status: 204 });
    if (path.endsWith("/chat/actions/open")) {
      posts.push(String(init?.body));
      return options.chat
        ? Response.json({ data: snapshot, tags: [] })
        : new Response("Not Found", { status: 404 });
    }
    return Response.json({ events: [], cursor: "" });
  });
  const client = { clientId: "tab-1", basePath: "/_parlor", request };
  return { client: client as unknown as ActionClient<Record<string, never>>, posts };
}

function Probe() {
  const chat = useChat();
  return (
    <div>
      <p data-testid="status">{chat.status}</p>
      <p data-testid="agents">
        {chat.agents.map((a) => `${a.name} on ${a.hostName}`).join(",")}
      </p>
      <Chat.Thread>{(item) => ("text" in item ? item.text : "")}</Chat.Thread>
    </div>
  );
}

describe("Chat.Root", () => {
  it("renders its children at once, then comes alive once the runtime has loaded", async () => {
    const { client, posts } = fakeClient({ chat: true });
    render(
      <FrameworkProvider client={client} sync={false}>
        <Chat.Root>
          <Probe />
        </Chat.Root>
      </FrameworkProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("running"));
    expect(screen.getByTestId("agents").textContent).toBe("Claude Code on Alice's Mac");
    expect(posts).toEqual(["{}"]);
  });

  it("streams tokens that arrive on the chat channel after the sync stream opened", async () => {
    const delta = JSON.stringify({
      type: "delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "turn_1.1",
      kind: "reply",
      offset: 3,
      text: "lo",
    });
    const { client } = fakeClient({ chat: true, streamFrames: [delta] });
    render(
      <FrameworkProvider client={client}>
        <Chat.Root>
          <Probe />
        </Chat.Root>
      </FrameworkProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("running"));
    await waitFor(() =>
      expect(screen.getByRole("listitem").dataset.streaming).toBe("true"),
    );
    await waitFor(() => expect(screen.getByRole("listitem").textContent).toBe("Hello"));
    expect(screen.getByRole("listitem").dataset.itemId).toBe("turn_1.1");
  });

  it("shows the unavailable state against a server that has no chat", async () => {
    const { client } = fakeClient({ chat: false });
    render(
      <FrameworkProvider client={client}>
        <Chat.Root>
          <Probe />
        </Chat.Root>
      </FrameworkProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("unavailable"),
    );
    act(() => {});
    expect(screen.queryAllByRole("listitem")).toEqual([]);
  });
});
