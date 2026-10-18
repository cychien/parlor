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

function setup(options: { dev?: boolean; next?: Record<string, string> } = {}) {
  const browser = fakeBrowser();
  const sent: ClientMessage[] = [];
  const client = createAgentUiClient({
    queries: { active: () => [], settled: async () => {} },
    send: async (message) => {
      sent.push(message);
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
      { type: "presence", focused: false, visible: true, platform: "web" },
      { type: "presence", focused: true, visible: true, platform: "web" },
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
