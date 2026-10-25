import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../../action-client.js";
import type { SessionSnapshot, SessionSource } from "../../session.js";
import * as Chat from "../agent-ui/chat.js";
import { useAgentConfirmations } from "../agent-ui/use-agent-confirmations.js";
import { FrameworkProvider } from "../provider.js";
import { useChat } from "./use-chat.js";

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

function fakeClient(options: { chat: boolean | "forbidden"; streamFrames?: string[] }) {
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
      const capabilities = options.chat === true ? ["ui", "chat"] : ["ui"];
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
      if (options.chat === "forbidden") {
        return Response.json(
          { error: { code: "forbidden", message: "This account cannot use chat." } },
          { status: 403 },
        );
      }
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
      <p data-testid="unavailable">{chat.unavailable?.reason}</p>
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
    expect(screen.getByTestId("unavailable").textContent).toBe("not_found");
    expect(screen.queryAllByRole("listitem")).toEqual([]);
  });

  it("says the agent is forbidden when the server's chat access refuses the user", async () => {
    const { client, posts } = fakeClient({ chat: "forbidden" });
    render(
      <FrameworkProvider client={client}>
        <Chat.Root>
          <Probe />
        </Chat.Root>
      </FrameworkProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("unavailable").textContent).toBe("forbidden"),
    );
    expect(screen.getByTestId("status").textContent).toBe("unavailable");
    expect(posts).toHaveLength(1);
  });
});

describe("Chat.Root across a change of the signed-in user", () => {
  type Who = "alice" | "bob" | "nobody";

  const account = (who: Exclude<Who, "nobody">) => ({
    threads: [{ id: `thr_${who}`, title: `${who}'s thread`, updatedAt: 1, lastSeq: 1 }],
    hosts: [
      {
        id: `host_${who}`,
        name: `${who}'s Mac`,
        platform: "macos",
        online: true,
        agents: [{ id: "claude", name: "Claude Code", ready: true }],
      },
    ],
    page: {
      thread: { id: `thr_${who}`, title: `${who}'s thread`, updatedAt: 1, lastSeq: 1 },
      items: [
        {
          id: `item_${who}`,
          threadId: `thr_${who}`,
          turnId: `turn_${who}`,
          seq: 1,
          at: 1,
          author: "user",
          kind: "prompt",
          body: {
            text: `${who}'s private prompt`,
            agent: { hostId: `host_${who}`, agentId: "claude" },
          },
        },
      ],
      open: [],
      turns: [
        {
          turnId: `turn_${who}`,
          state: "running",
          agent: { hostId: `host_${who}`, agentId: "claude" },
        },
      ],
      hasMore: false,
    },
  });

  const aliceCard = JSON.stringify({
    type: "confirmations",
    items: [
      {
        id: "c_alice",
        action: "deleteTask",
        description: "Delete a task.",
        input: { id: "t1" },
        origin: { via: "agent", name: "Claude Code" },
        expiresInMs: 59_000,
        threadId: "thr_alice",
      },
    ],
  });

  function accounts() {
    let who: Who = "alice";
    const posts: { type: string; watching?: string[] }[] = [];
    const bobOpen: { release?: () => void } = {};
    const encoder = new TextEncoder();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sync/token")) {
        if (who === "nobody") return new Response(null, { status: 401 });
        return Response.json({
          protocol: 1,
          transport: "sse",
          endpoint: "/_parlor/sync/stream",
          pollIntervalMs: 2000,
        });
      }
      if (path.includes("/sync/stream")) {
        const frames = [
          `event: handshake\ndata: ${JSON.stringify({ protocol: 1, capabilities: ["ui", "chat"] })}\n\n`,
          ...(who === "alice" ? [`event: ui\ndata: ${aliceCard}\n\n`] : []),
        ];
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) controller.enqueue(encoder.encode(frame));
            },
          }),
        );
      }
      if (path.endsWith("/ui")) {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/chat/actions/open")) {
        if (who === "nobody") return new Response("Unauthorized", { status: 401 });
        if (who === "alice") return Response.json({ data: account("alice"), tags: [] });
        await new Promise<void>((resolve) => (bobOpen.release = resolve));
        return Response.json({ data: account("bob"), tags: [] });
      }
      return Response.json({ events: [], cursor: "" });
    });
    const client = { clientId: "tab-1", basePath: "/_parlor", request };
    return {
      client: client as unknown as ActionClient<Record<string, never>>,
      posts,
      bobOpen,
      become(next: Who) {
        who = next;
      },
    };
  }

  function session(initial: SessionSnapshot) {
    let current = initial;
    const listeners = new Set<() => void>();
    const source: SessionSource = {
      current: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      source,
      set(next: SessionSnapshot) {
        current = next;
        for (const listener of listeners) listener();
      },
    };
  }

  const signedIn = (id: string): SessionSnapshot => ({
    status: "signed-in",
    user: { id, name: id, email: `${id}@example.com` },
  });

  function Everything() {
    const chat = useChat();
    const cards = useAgentConfirmations();
    return (
      <output data-testid="chat">
        {JSON.stringify({
          cards: cards.map((card) => card.id),
          status: chat.status,
          thread: chat.thread?.id ?? null,
          threads: chat.threads.map((t) => t.id),
          hosts: chat.hosts.map((h) => h.name),
          items: chat.items.map((item) => item.id),
        })}
      </output>
    );
  }

  const shown = () => JSON.parse(screen.getByTestId("chat").textContent!);

  it("drops everything of the first user, then shows only the second user's data", async () => {
    const fake = accounts();
    const auth = session(signedIn("alice"));
    render(
      <FrameworkProvider client={fake.client} auth={auth.source}>
        <Chat.Root>
          <Everything />
        </Chat.Root>
      </FrameworkProvider>,
    );
    await waitFor(() =>
      expect(shown()).toEqual({
        status: "running",
        thread: "thr_alice",
        threads: ["thr_alice"],
        hosts: ["alice's Mac"],
        items: ["item_alice", "c_alice"],
        cards: ["c_alice"],
      }),
    );
    await waitFor(() =>
      expect(fake.posts.at(-1)).toMatchObject({
        type: "presence",
        watching: ["thr_alice"],
      }),
    );

    fake.become("nobody");
    act(() => auth.set({ status: "signed-out" }));
    expect(shown()).toEqual({
      status: "loading",
      thread: null,
      threads: [],
      hosts: [],
      items: [],
      cards: [],
    });

    fake.become("bob");
    const afterAlice = fake.posts.length;
    act(() => auth.set(signedIn("bob")));
    expect(shown()).toEqual({
      status: "loading",
      thread: null,
      threads: [],
      hosts: [],
      items: [],
      cards: [],
    });
    await waitFor(() => expect(fake.bobOpen.release).toBeDefined());
    fake.bobOpen.release?.();
    await waitFor(() =>
      expect(shown()).toEqual({
        status: "running",
        thread: "thr_bob",
        threads: ["thr_bob"],
        hosts: ["bob's Mac"],
        items: ["item_bob"],
        cards: [],
      }),
    );
    await waitFor(() =>
      expect(fake.posts.at(-1)).toMatchObject({
        type: "presence",
        watching: ["thr_bob"],
      }),
    );
    expect(
      fake.posts.slice(afterAlice).flatMap((post) => post.watching ?? []),
    ).not.toContain("thr_alice");
    expect(screen.getByTestId("chat").textContent).not.toContain("alice");
  });
});
