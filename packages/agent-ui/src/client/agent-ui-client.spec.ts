// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import type { ClientMessage } from "../protocol.js";
import { defineAgentView } from "../view.js";
import { createAgentUiClient } from "./agent-ui-client.js";
import { fakeBrowser } from "./fake-browser.testing.js";

const note = defineAgentView({
  name: "note",
  description: "The open note.",
  schema: z.object({ text: z.string() }),
});

const row = defineAgentView({
  name: "row",
  description: "A list row.",
  keyed: true,
  schema: zm.object({ n: zm.number() }),
});

const request = (id: string, op = "screen", input: unknown = {}) =>
  JSON.stringify({ id, op, input, origin: { via: "mcp" }, timeoutMs: 1000 });

function setup(
  options: {
    dev?: boolean;
    next?: Record<string, string>;
    hold?: (message: ClientMessage) => Promise<void> | undefined;
  } = {},
) {
  const browser = fakeBrowser();
  const sent: ClientMessage[] = [];
  const client = createAgentUiClient({
    queries: { active: () => [], settled: async () => {} },
    send: async (message) => {
      sent.push(message);
      await options.hold?.(message);
      return message.type === "reply" ? options.next?.[message.id] : undefined;
    },
    platform: "web",
    environment: browser.env,
    dev: options.dev ?? false,
  });
  const gets = vi.fn(() => ({ text: "draft" }));
  const slot = client.views.track(note, { get: gets });
  slot.mount(undefined);
  const replies = () => sent.filter((m) => m.type === "reply");
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { browser, client, sent, gets, replies, settle };
}

afterEach(() => vi.restoreAllMocks());

describe("createAgentUiClient requests", () => {
  it("answers a screen request with the snapshot", async () => {
    const { client, replies, settle } = setup();
    client.receive(request("r1"));
    await settle();
    expect(replies()).toEqual([
      {
        type: "reply",
        id: "r1",
        ok: true,
        result: {
          route: null,
          queries: [],
          views: { note: { value: { text: "draft" } } },
          attention: {
            focus: null,
            selection: null,
            lastInteracted: null,
            lastEntered: null,
            focal: null,
          },
          truncated: false,
        },
      },
    ]);
  });

  it("re-sends the cached reply for a request it already answered instead of running it again", async () => {
    const { client, replies, gets, settle } = setup();
    client.receive(request("r1"));
    await settle();
    client.receive(request("r1"));
    client.receive(request("r1"));
    await settle();
    expect(gets).toHaveBeenCalledTimes(1);
    expect(replies()).toHaveLength(3);
    expect(replies()[2]).toEqual(replies()[0]);
  });

  it("runs requests one at a time in arrival order and ignores a duplicate still in the queue", async () => {
    const { client, replies, settle } = setup();
    client.receive(request("r1"));
    client.receive(request("r2"));
    client.receive(request("r2"));
    await settle();
    expect(replies().map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("runs the request the server hands back in answer to a reply", async () => {
    const { client, replies, gets, settle } = setup({
      next: { r1: request("r2"), r2: request("r3") },
    });
    client.receive(request("r1"));
    await settle();
    expect(replies().map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(gets).toHaveBeenCalledTimes(3);
  });

  it("replies with an internal error to a request it cannot parse", async () => {
    const { client, replies, settle } = setup();
    client.receive(request("r9", "explode"));
    client.receive("not json");
    await settle();
    expect(replies()).toEqual([
      {
        type: "reply",
        id: "r9",
        ok: false,
        error: { code: "internal", message: "The app could not read this UI request." },
      },
    ]);
  });
});

describe("createAgentUiClient snapshot timing", () => {
  const ROW = 30;

  function mountRows(
    browser: ReturnType<typeof setup>["browser"],
    client: ReturnType<typeof setup>["client"],
    count: number,
  ) {
    return Array.from({ length: count }, (_, n) => {
      const element = browser.document.createElement("li");
      browser.document.body.appendChild(element);
      browser.setRect(element, n * ROW, ROW);
      const slot = client.views.track(row, { key: `r${n}`, get: () => ({ n }) });
      slot.ref(element);
      slot.mount(`r${n}`);
      return element;
    });
  }

  const shownRows = (reply: ClientMessage | undefined) =>
    (
      reply as { result: { views: { row: { items: { key: string }[] } } } }
    ).result.views.row.items.map((item) => item.key);

  it("waits for the observer's first report instead of measuring every row that just mounted", async () => {
    const { browser, client, replies, settle } = setup();
    const elements = mountRows(browser, client, 1000);
    const rect = vi.spyOn(browser.env, "rect");
    client.receive(request("r1"));
    await settle();
    expect(replies()).toEqual([]);
    expect(rect).not.toHaveBeenCalled();
    elements.forEach((element, n) => browser.intersect(element, n * ROW < 600));
    await settle();
    expect(shownRows(replies()[0])).toEqual(
      Array.from({ length: 20 }, (_, n) => `r${n}`),
    );
    expect(rect.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("measures the rows itself when the observer stays silent", async () => {
    const { browser, client, replies } = setup();
    mountRows(browser, client, 40);
    client.receive(request("r1"));
    await new Promise((r) => setTimeout(r, 150));
    expect(shownRows(replies()[0])).toEqual(
      Array.from({ length: 20 }, (_, n) => `r${n}`),
    );
  });

  it("does not wait for the observer in a hidden page, which does not render", async () => {
    const { browser, client, replies, settle } = setup();
    vi.spyOn(browser.document, "visibilityState", "get").mockReturnValue("hidden");
    mountRows(browser, client, 40);
    client.receive(request("r1"));
    await settle();
    expect(shownRows(replies()[0])).toHaveLength(20);
  });

  it("answers right away once every row has been reported", async () => {
    const { browser, client, settle } = setup();
    const elements = mountRows(browser, client, 40);
    elements.forEach((element, n) => browser.intersect(element, n * ROW < 600));
    const rect = vi.spyOn(browser.env, "rect");
    const snapshot = client.screen();
    await settle();
    await expect(snapshot).resolves.toMatchObject({ views: { row: { offscreen: 20 } } });
    expect(rect).toHaveBeenCalledTimes(20);
  });
});

describe("createAgentUiClient writes", () => {
  const form = defineAgentView({
    name: "form",
    description: "A form.",
    schema: z.object({ title: z.string(), notes: z.string() }),
    writable: ["title", "notes"],
  });

  it("answers a set request by writing through the view's set and reading the value back", async () => {
    const { client, replies, settle } = setup();
    let value = { title: "", notes: "" };
    client.views
      .track(form, {
        get: () => value,
        set: (next) => {
          value = next as typeof value;
        },
      })
      .mount(undefined);
    client.receive(
      request("w1", "set", { view: "form", value: { title: "Buy stamps" } }),
    );
    await settle();
    expect(replies()).toEqual([
      {
        type: "reply",
        id: "w1",
        ok: true,
        result: { value: { title: "Buy stamps", notes: "" }, agentFields: ["title"] },
      },
    ]);
  });

  it("answers a refused write with the error code and shows the agent as busy only while it runs", async () => {
    const { client, replies, settle } = setup();
    client.receive(request("w1", "set", { view: "form", value: { title: "x" } }));
    await settle();
    expect(replies()).toEqual([
      {
        type: "reply",
        id: "w1",
        ok: false,
        error: { code: "not_mounted", message: expect.any(String) },
      },
    ]);
    expect(client.activity.get()).toEqual({
      busy: false,
      last: { op: "set", origin: { via: "mcp" }, at: 10_000 },
    });
  });

  it("answers a malformed set request with an internal error instead of running it, and still runs a well-formed one", async () => {
    const { client, replies, settle } = setup();
    const set = vi.fn();
    client.views
      .track(form, { get: () => ({ title: "", notes: "" }), set })
      .mount(undefined);
    client.receive(request("w1", "set", { view: "form", value: "title" }));
    await settle();
    expect(replies()[0]).toMatchObject({
      id: "w1",
      ok: false,
      error: { code: "internal" },
    });
    expect(set).not.toHaveBeenCalled();
    client.receive(request("w2", "set", { view: "form", value: { title: "x" } }));
    await settle();
    expect(replies()[1]).toMatchObject({ id: "w2", ok: true });
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe("createAgentUiClient highlight", () => {
  it("answers a highlight request with how much of the view shows after scrolling", async () => {
    const { browser, client, replies } = setup();
    const element = browser.document.createElement("section");
    browser.document.body.appendChild(element);
    browser.setRect(element, 2000, 100);
    browser.onScroll((scrolled) => browser.setRect(scrolled, 250, 100));
    const slot = client.views.track(note, { get: () => ({ text: "draft" }) });
    slot.ref(element);
    slot.mount(undefined);
    client.receive(request("h1", "highlight", { view: "note" }));
    await vi.waitFor(() => expect(replies()).toHaveLength(1));
    expect(replies()).toEqual([
      { type: "reply", id: "h1", ok: true, result: { shown: 1 } },
    ]);
  });

  it("answers not_mounted for a view that is not on screen", async () => {
    const { client, replies, settle } = setup();
    client.receive(request("h1", "highlight", { view: "nope" }));
    await settle();
    expect(replies()[0]).toMatchObject({ ok: false, error: { code: "not_mounted" } });
  });
});

describe("createAgentUiClient activity", () => {
  it("is busy while a request runs and remembers the last operation", async () => {
    const { client, settle } = setup();
    const seen: boolean[] = [];
    const off = client.activity.subscribe(() => seen.push(client.activity.get().busy));
    client.receive(request("r1"));
    await settle();
    expect(seen).toEqual([true, false]);
    expect(client.activity.get()).toEqual({
      busy: false,
      last: { op: "screen", origin: { via: "mcp" }, at: 10_000 },
    });
    off();
  });

  it("warns once in dev when an agent request arrives and nothing shows activity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, settle } = setup({ dev: true });
    client.receive(request("r1"));
    client.receive(request("r2"));
    await settle();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("useAgentActivity");
  });

  it("does not warn when something subscribes to activity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, settle } = setup({ dev: true });
    client.activity.subscribe(() => {});
    client.receive(request("r1"));
    await settle();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createAgentUiClient presence", () => {
  it("reports presence when the channel opens and again only when focus or visibility changes", async () => {
    const { browser, client, sent, settle } = setup();
    const focused = vi.spyOn(browser.document, "hasFocus").mockReturnValue(false);
    client.opened();
    await settle();
    focused.mockReturnValue(true);
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    await settle();
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    await settle();
    client.closed();
    focused.mockReturnValue(false);
    browser.window.dispatchEvent(new browser.window.Event("blur"));
    await settle();
    expect(sent).toEqual([
      {
        type: "presence",
        focused: false,
        visible: true,
        platform: "web",
        ops: ["screen", "navigate", "set", "highlight"],
      },
      {
        type: "presence",
        focused: true,
        visible: true,
        platform: "web",
        ops: ["screen", "navigate", "set", "highlight"],
      },
    ]);
  });
});

describe("createAgentUiClient leaving", () => {
  it("announces it is leaving right away when the page goes away", async () => {
    const { browser, client, sent, settle } = setup();
    client.opened();
    await settle();
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    expect(sent.at(-1)).toEqual({ type: "leave" });
  });

  it("announces itself again when the page comes back from the back-forward cache", async () => {
    const { browser, client, sent, settle } = setup();
    client.opened();
    await settle();
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    browser.window.dispatchEvent(new browser.window.Event("pageshow"));
    await settle();
    expect(sent.map((message) => message.type)).toEqual([
      "presence",
      "leave",
      "presence",
    ]);
  });
});

describe("createAgentUiClient lifecycle ordering", () => {
  it("sends the presence of a restored page only after the leave from before it went away was delivered", async () => {
    let deliverLeave!: () => void;
    const { browser, client, sent, settle } = setup({
      hold: (message) =>
        message.type === "leave"
          ? new Promise<void>((resolve) => (deliverLeave = resolve))
          : undefined,
    });
    client.opened();
    await settle();
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    browser.window.dispatchEvent(new browser.window.Event("pageshow"));
    await settle();
    expect(sent.map((message) => message.type)).toEqual(["presence", "leave"]);
    deliverLeave();
    await settle();
    expect(sent.map((message) => message.type)).toEqual([
      "presence",
      "leave",
      "presence",
    ]);
  });

  it("sends presence after a leave that failed, once it has failed", async () => {
    let failLeave!: () => void;
    const { browser, client, sent, settle } = setup({
      hold: (message) =>
        message.type === "leave"
          ? new Promise<void>(
              (_, reject) => (failLeave = () => reject(new Error("offline"))),
            )
          : undefined,
    });
    client.opened();
    await settle();
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    browser.window.dispatchEvent(new browser.window.Event("pageshow"));
    await settle();
    expect(sent.map((message) => message.type)).toEqual(["presence", "leave"]);
    failLeave();
    await settle();
    expect(sent.map((message) => message.type)).toEqual([
      "presence",
      "leave",
      "presence",
    ]);
  });
});

describe("createAgentUiClient after leaving", () => {
  it("stays silent about presence while the page is gone, even when focus and visibility change after pagehide", async () => {
    const { browser, client, sent, settle } = setup();
    client.opened();
    await settle();
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(false);
    browser.window.dispatchEvent(new browser.window.Event("blur"));
    browser.document.dispatchEvent(new browser.window.Event("visibilitychange"));
    await settle();
    expect(sent.map((message) => message.type)).toEqual(["presence", "leave"]);
  });
});

describe("createAgentUiClient navigate", () => {
  async function routed(settled = async () => {}) {
    const { createMemoryHistory, createRootRoute, createRoute, createRouter } =
      await import("@tanstack/react-router");
    const root = createRootRoute();
    const listed = createRoute({
      getParentRoute: () => root,
      path: "/",
      staticData: { views: [note] },
    });
    const settings = createRoute({ getParentRoute: () => root, path: "/settings" });
    const detail = createRoute({ getParentRoute: () => root, path: "/tasks/$taskId" });
    const router = createRouter({
      routeTree: root.addChildren([listed, settings, detail]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    router.history.subscribe(() => void router.load());
    await router.load();
    const browser = fakeBrowser();
    const sent: ClientMessage[] = [];
    const client = createAgentUiClient({
      router,
      queries: { active: () => [], settled },
      send: async (message) => {
        sent.push(message);
        return undefined;
      },
      platform: "web",
      environment: browser.env,
      dev: true,
    });
    return {
      browser,
      client,
      router,
      sent,
      settle: () => new Promise((r) => setTimeout(r, 20)),
    };
  }

  it("navigates to a route with params and returns the new screen", async () => {
    const settled = vi.fn(async () => {});
    const { client, router, sent, settle } = await routed(settled);
    client.receive(
      request("n1", "navigate", { to: "/tasks/$taskId", params: { taskId: "t1" } }),
    );
    await settle();
    expect(router.state.location.pathname).toBe("/tasks/t1");
    expect(sent).toEqual([
      {
        type: "reply",
        id: "n1",
        ok: true,
        result: {
          screen: expect.objectContaining({
            route: {
              notFound: false,
              path: "/tasks/$taskId",
              params: { taskId: "t1" },
              search: {},
              url: "/tasks/t1",
            },
          }),
        },
      },
    ]);
    expect(settled).toHaveBeenCalledWith(expect.any(Number));
  });

  it("returns the new screen only after the observer reports the rows the page mounted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { browser, client, sent, settle } = await routed();
    const element = browser.document.createElement("li");
    browser.document.body.appendChild(element);
    browser.setRect(element, 0, 30);
    const slot = client.views.track(row, { key: "r0", get: () => ({ n: 0 }) });
    slot.ref(element);
    slot.mount("r0");
    client.receive(request("n3", "navigate", { to: "/settings" }));
    await settle();
    expect(sent).toEqual([]);
    browser.intersect(element, true);
    await settle();
    expect(sent).toEqual([
      {
        type: "reply",
        id: "n3",
        ok: true,
        result: {
          screen: expect.objectContaining({
            views: {
              row: { items: [{ key: "r0", value: { n: 0 }, shown: 1 }], offscreen: 0 },
            },
          }),
        },
      },
    ]);
  });

  it("refuses a path the router does not know", async () => {
    const { client, router, sent, settle } = await routed();
    client.receive(request("n2", "navigate", { to: "/nope" }));
    await settle();
    expect(router.state.location.pathname).toBe("/");
    expect(sent).toEqual([
      {
        type: "reply",
        id: "n2",
        ok: false,
        error: { code: "unknown_route", message: "This app has no route /nope." },
      },
    ]);
  });

  it("warns in dev when a view mounts on a route that does not list it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, router } = await routed();
    client.views.track(note, { get: () => ({ text: "" }) }).mount(undefined);
    expect(warn).not.toHaveBeenCalled();
    await router.navigate({ to: "/settings" });
    client.views.track(note, { get: () => ({ text: "" }) }).mount(undefined);
    client.views.track(note, { get: () => ({ text: "" }) }).mount(undefined);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('"note"');
  });
});
