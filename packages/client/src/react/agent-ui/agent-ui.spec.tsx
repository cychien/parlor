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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactElement, StrictMode, useCallback, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { useActionQuery } from "../hooks.js";
import { FrameworkProvider } from "../provider.js";
import { agentRequest, fakeClient } from "./fake-client.testing.js";
import { useAgentActivity } from "./use-agent-activity.js";
import { useAgentConfirmations } from "./use-agent-confirmations.js";
import { useAgentView } from "./use-agent-view.js";

const greeting = defineAgentView({
  name: "greeting",
  description: "The name being greeted.",
  schema: z.object({ name: z.string() }),
});

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
      ops: ["screen", "navigate", "set", "highlight"],
      canConfirm: false,
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

const composeTask = defineAgentView({
  name: "composeTask",
  description: "The new task form.",
  schema: z.object({ title: z.string(), notes: z.string() }),
  writable: ["title", "notes"],
});

function ComposeTask() {
  const [draft, setDraft] = useState({ title: "", notes: "" });
  const { ref, agentFields } = useAgentView(composeTask, {
    get: () => draft,
    set: setDraft,
  });
  return (
    <form ref={ref}>
      <input
        aria-label="Title"
        name="title"
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        data-agent-filled={agentFields.has("title") || undefined}
      />
      <input
        aria-label="Notes"
        name="notes"
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        data-agent-filled={agentFields.has("notes") || undefined}
      />
      <button type="button" onClick={() => setDraft({ title: "", notes: "" })}>
        Reset
      </button>
    </form>
  );
}

function UncontrolledComposeTask() {
  const form = useRef<HTMLFormElement | null>(null);
  const { ref, agentFields } = useAgentView(composeTask, {
    get: () =>
      form.current
        ? (Object.fromEntries(new FormData(form.current)) as {
            title: string;
            notes: string;
          })
        : { title: "", notes: "" },
    set: (next) => {
      for (const [name, value] of Object.entries(next)) {
        (form.current!.elements.namedItem(name) as HTMLInputElement).value =
          String(value);
      }
    },
  });
  const attach = useCallback(
    (element: HTMLFormElement | null) => {
      form.current = element;
      ref(element);
    },
    [ref],
  );
  return (
    <form ref={attach}>
      <input
        aria-label="Title"
        name="title"
        defaultValue=""
        data-agent-filled={agentFields.has("title") || undefined}
      />
      <input
        aria-label="Notes"
        name="notes"
        defaultValue=""
        data-agent-filled={agentFields.has("notes") || undefined}
      />
    </form>
  );
}

describe("agent writes to an uncontrolled form in FrameworkProvider", () => {
  it("takes the marking off a field the user types over, though typing does not re-render the form", async () => {
    const { client, posts } = fakeClient({
      request: agentRequest("w1", "set", {
        view: "composeTask",
        value: { title: "Plan trip", notes: "book hotel" },
      }),
    });
    render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <UncontrolledComposeTask />
      </FrameworkProvider>,
    );
    const filled = (label: string) =>
      screen.getByLabelText(label).hasAttribute("data-agent-filled");
    await waitFor(() => expect(posts).toHaveLength(2));
    expect([filled("Title"), filled("Notes")]).toEqual([true, true]);
    fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Plan trip!" } });
    expect([filled("Title"), filled("Notes")]).toEqual([false, true]);
  });
});

function runMicrotasksBetweenListeners() {
  const targets = Object.getPrototypeOf(Node.prototype) as EventTarget;
  const { addEventListener, removeEventListener } = targets;
  const wrappers = new WeakMap<EventListener, EventListener>();
  const wrap = (listener: EventListener) => {
    let wrapper = wrappers.get(listener);
    if (!wrapper) {
      wrapper = function (this: unknown, event) {
        try {
          return listener.call(this, event);
        } finally {
          if (event.type === "input") flushSync(() => {});
        }
      };
      wrappers.set(listener, wrapper);
    }
    return wrapper;
  };
  targets.addEventListener = function (type, listener, options) {
    addEventListener.call(
      this,
      type,
      typeof listener === "function" ? wrap(listener) : listener,
      options,
    );
  };
  targets.removeEventListener = function (type, listener, options) {
    removeEventListener.call(
      this,
      type,
      typeof listener === "function" ? wrap(listener) : listener,
      options,
    );
  };
  return () => Object.assign(targets, { addEventListener, removeEventListener });
}

describe("the user types into a form after an agent wrote to it", () => {
  let restoreListeners: () => void;
  beforeEach(() => {
    restoreListeners = runMicrotasksBetweenListeners();
  });
  afterEach(() => restoreListeners());

  const type = (label: string, text: string) => {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    for (const typed of [...text].map((_, i) => text.slice(0, i + 1))) {
      fireEvent.input(input, { target: { value: typed } });
    }
    return input;
  };
  const value = (label: string) =>
    (screen.getByLabelText(label) as HTMLInputElement).value;
  const filled = (label: string) =>
    screen.getByLabelText(label).hasAttribute("data-agent-filled");
  const renderWritten = async (form: ReactElement, written: unknown) => {
    const { client, posts } = fakeClient({
      request: agentRequest("w1", "set", { view: "composeTask", value: written }),
    });
    render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {form}
      </FrameworkProvider>,
    );
    await waitFor(() => expect(posts).toHaveLength(2));
  };

  it("keeps every keystroke in a controlled field, written by the agent or not", async () => {
    await renderWritten(<ComposeTask />, { notes: "n1" });
    type("Title", "draft");
    expect(value("Title")).toBe("draft");
    type("Notes", "mine");
    expect(value("Notes")).toBe("mine");
    expect([filled("Title"), filled("Notes")]).toEqual([false, false]);
  });

  it("keeps every keystroke in an uncontrolled field", async () => {
    await renderWritten(<UncontrolledComposeTask />, { notes: "n1" });
    type("Title", "draft");
    expect(value("Title")).toBe("draft");
    type("Notes", "mine");
    expect(value("Notes")).toBe("mine");
    expect([filled("Title"), filled("Notes")]).toEqual([false, false]);
  });

  it.each([
    ["controlled", <ComposeTask key="c" />],
    ["uncontrolled", <UncontrolledComposeTask key="u" />],
  ])(
    "takes the marking off a %s field for good once the user edits it",
    async (_, form) => {
      await renderWritten(form, { title: "Plan trip", notes: "book hotel" });
      expect([filled("Title"), filled("Notes")]).toEqual([true, true]);
      type("Title", "Plan trip!");
      expect([filled("Title"), filled("Notes")]).toEqual([false, true]);
      type("Title", "Plan trip");
      expect(filled("Title")).toBe(false);
    },
  );

  it("lets the user type again after the form was reset", async () => {
    await renderWritten(<ComposeTask />, { title: "Agent title" });
    expect(filled("Title")).toBe(true);
    fireEvent.click(screen.getByText("Reset"));
    expect(value("Title")).toBe("");
    expect(filled("Title")).toBe(false);
    type("Title", "Mine");
    expect(value("Title")).toBe("Mine");
    expect(filled("Title")).toBe(false);
  });
});

describe("agent writes in FrameworkProvider", () => {
  const write = (value: unknown) =>
    agentRequest("w1", "set", { view: "composeTask", value });
  const renderForm = (request: string, strict = false) => {
    const { client, posts } = fakeClient({ request });
    const tree = (
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ComposeTask />
      </FrameworkProvider>
    );
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    return posts;
  };
  const filled = (label: string) =>
    screen.getByLabelText(label).hasAttribute("data-agent-filled");

  it.each([false, true])(
    "fills the form, answers with the committed value, and marks the written fields (StrictMode %s)",
    async (strict) => {
      const posts = renderForm(
        write({ title: "Buy stamps", notes: "for the tax letter" }),
        strict,
      );
      await waitFor(() =>
        expect(posts).toContainEqual({
          type: "reply",
          id: "w1",
          ok: true,
          result: {
            value: { title: "Buy stamps", notes: "for the tax letter" },
            agentFields: ["title", "notes"],
          },
        }),
      );
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
        "Buy stamps",
      );
      expect((screen.getByLabelText("Notes") as HTMLInputElement).value).toBe(
        "for the tax letter",
      );
      expect([filled("Title"), filled("Notes")]).toEqual([true, true]);
    },
  );

  it("takes the marking off a field the user edits and off every field when the form resets", async () => {
    const posts = renderForm(write({ title: "Plan trip", notes: "book hotel" }));
    await waitFor(() => expect(filled("Notes")).toBe(true));
    expect(posts).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Plan trip!" } });
    expect([filled("Title"), filled("Notes")]).toEqual([false, true]);
    fireEvent.click(screen.getByText("Reset"));
    expect([filled("Title"), filled("Notes")]).toEqual([false, false]);
  });

  it("points at a field: focuses it and marks it for the app's styling", async () => {
    const posts = renderForm(
      agentRequest("h1", "highlight", { view: "composeTask", field: "notes" }),
    );
    await waitFor(() =>
      expect(posts).toContainEqual({
        type: "reply",
        id: "h1",
        ok: true,
        result: { shown: expect.any(Number) },
      }),
    );
    const notes = screen.getByLabelText("Notes");
    expect(document.activeElement).toBe(notes);
    expect(notes.hasAttribute("data-parlor-highlight")).toBe(true);
    expect(screen.getByLabelText("Title").hasAttribute("data-parlor-highlight")).toBe(
      false,
    );
  });

  it("refuses a field the schema rejects and leaves the form alone", async () => {
    const posts = renderForm(write({ title: 42 }));
    await waitFor(() =>
      expect(posts).toContainEqual(
        expect.objectContaining({
          id: "w1",
          ok: false,
          error: expect.objectContaining({ code: "invalid_value" }),
        }),
      ),
    );
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect(filled("Title")).toBe(false);
  });
});

function Cards() {
  const confirmations = useAgentConfirmations();
  const { busy, last } = useAgentActivity();
  return (
    <section>
      <output>{busy ? `agent ${last?.op}` : "idle"}</output>
      {confirmations.map((c) => (
        <div key={c.id} role="alertdialog" aria-label={`Confirm ${c.action}`}>
          <p>
            {c.origin.name} wants to run {c.action}
          </p>
          <button type="button" onClick={c.approve}>
            Approve
          </button>
          <button type="button" onClick={c.decline}>
            Decline
          </button>
        </div>
      ))}
    </section>
  );
}

describe("confirmation cards in FrameworkProvider", () => {
  const card = (id: string) =>
    JSON.stringify({
      type: "confirmations",
      items: [
        {
          id,
          action: "deleteTask",
          description: "Delete a task.",
          input: { id: "t1" },
          origin: { via: "mcp", name: "Claude Code" },
          expiresInMs: 59_000,
        },
      ],
    });
  const renderCards = (strict: boolean) => {
    const { client, posts } = fakeClient({ request: card("c1") });
    const tree = (
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Cards />
      </FrameworkProvider>
    );
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    return posts;
  };

  it.each([false, true])(
    "draws the card the server pushes, says it can, and posts the answer on Approve (StrictMode %s)",
    async (strict) => {
      const posts = renderCards(strict);
      const dialog = await screen.findByRole("alertdialog", {
        name: "Confirm deleteTask",
      });
      expect(dialog.textContent).toContain("Claude Code wants to run deleteTask");
      expect(screen.getByRole("status").textContent).toBe("agent confirm");
      await waitFor(() =>
        expect(posts).toContainEqual(
          expect.objectContaining({ type: "presence", canConfirm: true }),
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      await waitFor(() =>
        expect(posts).toContainEqual({ type: "answer", id: "c1", approve: true }),
      );
    },
  );

  it("posts a decline", async () => {
    const posts = renderCards(false);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(posts).toContainEqual({ type: "answer", id: "c1", approve: false }),
    );
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
