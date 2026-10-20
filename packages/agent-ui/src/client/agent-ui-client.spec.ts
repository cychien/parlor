// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import type { ClientMessage } from "../protocol.js";
import { defineAgentView } from "../view.js";
import { createAgentUiClient } from "./agent-ui-client.js";
import { scrollIntoCenter } from "./environment.js";
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
    paintsNoFrames?: boolean;
  } = {},
) {
  const browser = fakeBrowser();
  if (options.paintsNoFrames) {
    browser.window.requestAnimationFrame = () => 0;
  }
  const environment = options.paintsNoFrames
    ? {
        ...browser.env,
        scrollIntoView: (element: Element) => scrollIntoCenter(browser.window, element),
      }
    : browser.env;
  const sent: ClientMessage[] = [];
  const client = createAgentUiClient({
    queries: { active: () => [], settled: async () => {} },
    send: async (message) => {
      sent.push(message);
      await options.hold?.(message);
      return message.type === "reply" ? options.next?.[message.id] : undefined;
    },
    platform: "web",
    environment,
    dev: options.dev ?? false,
  });
  const gets = vi.fn(() => ({ text: "draft" }));
  const slot = client.views.track(note, { get: gets });
  slot.mount(undefined);
  const replies = () => sent.filter((m) => m.type === "reply");
  const answered = (count: number) =>
    vi.waitFor(() => expect(replies()).toHaveLength(count));
  const quiet = () => new Promise((r) => setTimeout(r, 10));
  return { browser, client, sent, gets, replies, answered, quiet };
}

afterEach(() => vi.restoreAllMocks());

describe("createAgentUiClient requests", () => {
  it("answers a screen request with the snapshot", async () => {
    const { client, replies, answered } = setup();
    client.receive(request("r1"));
    await answered(1);
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
    const { client, replies, gets, answered } = setup();
    client.receive(request("r1"));
    await answered(1);
    client.receive(request("r1"));
    client.receive(request("r1"));
    await answered(3);
    expect(gets).toHaveBeenCalledTimes(1);
    expect(replies()).toHaveLength(3);
    expect(replies()[2]).toEqual(replies()[0]);
  });

  it("runs requests one at a time in arrival order and ignores a duplicate still in the queue", async () => {
    const { client, replies, answered, quiet } = setup();
    client.receive(request("r1"));
    client.receive(request("r2"));
    client.receive(request("r2"));
    await answered(2);
    await quiet();
    expect(replies().map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("runs the request the server hands back in answer to a reply", async () => {
    const { client, replies, gets, answered } = setup({
      next: { r1: request("r2"), r2: request("r3") },
    });
    client.receive(request("r1"));
    await answered(3);
    expect(replies().map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(gets).toHaveBeenCalledTimes(3);
  });

  it("replies with an internal error to a request it cannot parse", async () => {
    const { client, replies, answered, quiet } = setup();
    client.receive(request("r9", "explode"));
    client.receive("not json");
    await answered(1);
    await quiet();
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
    const { browser, client, replies, answered, quiet } = setup();
    const elements = mountRows(browser, client, 1000);
    const rect = vi.spyOn(browser.env, "rect");
    vi.spyOn(browser.env, "setTimeout").mockReturnValue(0 as never);
    client.receive(request("r1"));
    await quiet();
    expect(replies()).toEqual([]);
    expect(rect).not.toHaveBeenCalled();
    elements.forEach((element, n) => browser.intersect(element, n * ROW < 600));
    await answered(1);
    expect(shownRows(replies()[0])).toEqual(
      Array.from({ length: 20 }, (_, n) => `r${n}`),
    );
    expect(rect.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("measures the rows itself when the observer stays silent", async () => {
    const { browser, client, replies, answered } = setup();
    mountRows(browser, client, 40);
    client.receive(request("r1"));
    await answered(1);
    expect(shownRows(replies()[0])).toEqual(
      Array.from({ length: 20 }, (_, n) => `r${n}`),
    );
  });

  it("does not wait for the observer in a hidden page, which does not render", async () => {
    const { browser, client, replies, answered } = setup();
    vi.spyOn(browser.document, "visibilityState", "get").mockReturnValue("hidden");
    mountRows(browser, client, 40);
    client.receive(request("r1"));
    await answered(1);
    expect(shownRows(replies()[0])).toHaveLength(20);
  });

  it("answers right away once every row has been reported", async () => {
    const { browser, client } = setup();
    const elements = mountRows(browser, client, 40);
    elements.forEach((element, n) => browser.intersect(element, n * ROW < 600));
    const rect = vi.spyOn(browser.env, "rect");
    const snapshot = client.screen();
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
    const { client, replies, answered } = setup();
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
    await answered(1);
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
    const { client, replies, answered } = setup();
    client.receive(request("w1", "set", { view: "form", value: { title: "x" } }));
    await answered(1);
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
      last: {
        op: "set",
        origin: { via: "mcp" },
        at: 10_000,
        outcome: { status: "refused", code: "not_mounted" },
      },
    });
  });

  it("answers a malformed set request with an internal error instead of running it, and still runs a well-formed one", async () => {
    const { client, replies, answered } = setup();
    const set = vi.fn();
    client.views
      .track(form, { get: () => ({ title: "", notes: "" }), set })
      .mount(undefined);
    client.receive(request("w1", "set", { view: "form", value: "title" }));
    await answered(1);
    expect(replies()[0]).toMatchObject({
      id: "w1",
      ok: false,
      error: { code: "internal" },
    });
    expect(set).not.toHaveBeenCalled();
    client.receive(request("w2", "set", { view: "form", value: { title: "x" } }));
    await answered(2);
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

  it("answers highlight and the request behind it when the page paints no frames", async () => {
    const { browser, client, replies } = setup({ paintsNoFrames: true });
    const element = browser.document.createElement("section");
    browser.document.body.appendChild(element);
    const slot = client.views.track(note, { get: () => ({ text: "draft" }) });
    slot.ref(element);
    slot.mount(undefined);
    client.receive(request("h1", "highlight", { view: "note" }));
    client.receive(request("s1"));
    await vi.waitFor(() => expect(replies().map((r) => r.id)).toEqual(["h1", "s1"]), {
      timeout: 1900,
    });
  });

  it("answers not_mounted for a view that is not on screen", async () => {
    const { client, replies, answered } = setup();
    client.receive(request("h1", "highlight", { view: "nope" }));
    await answered(1);
    expect(replies()[0]).toMatchObject({ ok: false, error: { code: "not_mounted" } });
  });
});

describe("createAgentUiClient confirmations", () => {
  const frame = (...ids: string[]) =>
    JSON.stringify({
      type: "confirmations",
      items: ids.map((id) => ({
        id,
        action: "deleteTask",
        description: "Delete a task.",
        input: { id: "t1" },
        origin: { via: "mcp", name: "Claude Code" },
        expiresInMs: 59_000,
      })),
    });

  it("shows the server's list through the confirmation store and never queues it as a request", async () => {
    const { client, replies, quiet } = setup();
    client.receive(frame("c1"));
    await quiet();
    expect(client.confirmations.get().map((c) => c.id)).toEqual(["c1"]);
    expect(replies()).toEqual([]);
    client.receive(frame());
    expect(client.confirmations.get()).toEqual([]);
  });

  it("drops every pending card on reset and is idle again", () => {
    const { client } = setup();
    client.receive(frame("c1", "c2"));
    expect(client.activity.get().busy).toBe(true);
    client.reset();
    expect(client.confirmations.get()).toEqual([]);
    expect(client.activity.get().busy).toBe(false);
  });

  it("answers over the channel when the user approves or declines", async () => {
    const { client, sent } = setup();
    client.receive(frame("c1", "c2"));
    client.confirmations.get()[0]!.approve();
    client.confirmations.get()[0]!.decline();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { type: "answer", id: "c1", approve: true },
      { type: "answer", id: "c2", approve: false },
    ]);
  });

  it("does not wait behind a card: a screen request runs while one is showing", async () => {
    const { client, replies, answered } = setup();
    client.receive(frame("c1"));
    client.receive(request("r1"));
    await answered(1);
    expect(client.confirmations.get().map((item) => item.id)).toEqual(["c1"]);
    expect(replies().map((r) => r.id)).toEqual(["r1"]);
  });

  it("is busy and says it is asking for confirmation while a card shows, idle once it leaves", () => {
    const { client } = setup();
    client.receive(frame("c1"));
    expect(client.activity.get()).toEqual({
      busy: true,
      last: { op: "confirm", origin: { via: "mcp", name: "Claude Code" }, at: 10_000 },
    });
    client.receive(frame());
    expect(client.activity.get()).toMatchObject({ busy: false, last: { op: "confirm" } });
  });

  it("stays busy for a card while a request finishes, and for the request while a card waits", async () => {
    const { client, answered } = setup();
    client.receive(frame("c1"));
    client.receive(request("r1"));
    await answered(1);
    expect(client.activity.get().busy).toBe(true);
    expect(client.activity.get().last?.op).toBe("screen");
    client.receive(frame());
    expect(client.activity.get().busy).toBe(false);
  });

  it("reports that it can confirm only while something renders the cards", async () => {
    const { browser, client, sent } = setup();
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const off = client.confirmations.subscribe(() => {});
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    off();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(
      sent
        .filter((m) => m.type === "presence")
        .map((m) => (m as { canConfirm?: boolean }).canConfirm),
    ).toEqual([false, true, false]);
  });
});

describe("createAgentUiClient activity", () => {
  it("is busy while a request runs and remembers the last operation", async () => {
    const { client, answered } = setup();
    const seen: boolean[] = [];
    const off = client.activity.subscribe(() => seen.push(client.activity.get().busy));
    client.receive(request("r1"));
    await answered(1);
    await vi.waitFor(() => expect(client.activity.get().busy).toBe(false));
    expect(seen).toEqual([true, false]);
    expect(client.activity.get()).toEqual({
      busy: false,
      last: {
        op: "screen",
        origin: { via: "mcp" },
        at: 10_000,
        outcome: { status: "done" },
      },
    });
    off();
  });

  const gated = defineAgentView({
    name: "gated",
    description: "A field whose write waits.",
    schema: z.object({ text: z.string() }),
    writable: ["text"],
  });

  it("has no outcome for the last operation while it runs, and keeps the operation", async () => {
    const { client, answered } = setup();
    let release = () => {};
    client.views
      .track(gated, {
        get: () => ({ text: "" }),
        set: () => new Promise<void>((resolve) => (release = resolve)),
      })
      .mount(undefined);
    client.receive(request("r1", "set", { view: "gated", value: { text: "x" } }));
    await vi.waitFor(() => expect(client.activity.get().busy).toBe(true));
    expect(client.activity.get().last?.op).toBe("set");
    expect(client.activity.get().last?.outcome).toBeUndefined();
    release();
    await answered(1);
    await vi.waitFor(() =>
      expect(client.activity.get().last?.outcome).toEqual({ status: "done" }),
    );
  });

  it.each([
    ["navigate", { to: "/nowhere" }, "unknown_route"],
    ["highlight", { view: "nope" }, "not_mounted"],
    ["set", { view: "note", value: { text: 42 } }, "not_writable"],
  ])("records a refused %s with the error code", async (op, input, code) => {
    const { client, answered } = setup();
    client.receive(request("r1", op, input));
    await answered(1);
    await vi.waitFor(() => expect(client.activity.get().busy).toBe(false));
    expect(client.activity.get().last).toMatchObject({
      op,
      outcome: { status: "refused", code },
    });
  });

  it("records a request the app failed to run as refused with the internal code", async () => {
    const { client, answered } = setup();
    client.views
      .track(gated, {
        get: () => ({ text: "" }),
        set: () => Promise.reject(new Error("boom")),
      })
      .mount(undefined);
    client.receive(request("r1", "set", { view: "gated", value: { text: "x" } }));
    await answered(1);
    await vi.waitFor(() => expect(client.activity.get().busy).toBe(false));
    expect(client.activity.get().last?.outcome).toEqual({
      status: "refused",
      code: "internal",
    });
  });

  it("clears the outcome when the next request starts", async () => {
    const { client, answered } = setup();
    let release = () => {};
    client.views
      .track(gated, {
        get: () => ({ text: "" }),
        set: () => new Promise<void>((resolve) => (release = resolve)),
      })
      .mount(undefined);
    client.receive(request("r1", "highlight", { view: "nope" }));
    await answered(1);
    client.receive(request("r2", "set", { view: "gated", value: { text: "x" } }));
    await vi.waitFor(() => expect(client.activity.get().busy).toBe(true));
    expect(client.activity.get().last?.op).toBe("set");
    expect(client.activity.get().last?.outcome).toBeUndefined();
    release();
    await answered(2);
  });

  it("warns once in dev when an agent request arrives and nothing shows activity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, answered } = setup({ dev: true });
    client.receive(request("r1"));
    client.receive(request("r2"));
    await answered(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("useAgentActivity");
  });

  it("does not warn when something subscribes to activity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, answered } = setup({ dev: true });
    client.activity.subscribe(() => {});
    client.receive(request("r1"));
    await answered(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createAgentUiClient presence", () => {
  it("reports presence when the channel opens and again only when focus or visibility changes", async () => {
    const { browser, client, sent, quiet } = setup();
    const focused = vi.spyOn(browser.document, "hasFocus").mockReturnValue(false);
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    focused.mockReturnValue(true);
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    await quiet();
    client.closed();
    focused.mockReturnValue(false);
    browser.window.dispatchEvent(new browser.window.Event("blur"));
    await quiet();
    expect(sent).toEqual([
      {
        type: "presence",
        focused: false,
        visible: true,
        platform: "web",
        ops: ["screen", "navigate", "set", "highlight"],
        canConfirm: false,
      },
      {
        type: "presence",
        focused: true,
        visible: true,
        platform: "web",
        ops: ["screen", "navigate", "set", "highlight"],
        canConfirm: false,
      },
    ]);
  });
});

describe("createAgentUiClient presence without a stream", () => {
  it("posts nothing while the channel is not open, then names what is watched when it opens", async () => {
    const { browser, client, sent, quiet } = setup();
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);

    client.watch("thr_1");
    browser.window.dispatchEvent(new browser.window.Event("focus"));
    await quiet();
    expect(sent).toEqual([]);

    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: "presence", watching: ["thr_1"] });
  });

  it("goes silent again once the channel closes, and resumes when it reopens", async () => {
    const { browser, client, sent, quiet } = setup();
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    client.closed();
    client.watch("thr_2");
    await quiet();
    expect(sent).toHaveLength(1);

    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ type: "presence", watching: ["thr_2"] });
  });
});

describe("createAgentUiClient leaving", () => {
  it("announces it is leaving right away when the page goes away", async () => {
    const { browser, client, sent } = setup();
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "leave" }));
  });

  it("announces itself again when the page comes back from the back-forward cache", async () => {
    const { browser, client, sent } = setup();
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    browser.window.dispatchEvent(new browser.window.Event("pageshow"));
    await vi.waitFor(() => expect(sent).toHaveLength(3));
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
    const { browser, client, sent, quiet } = setup({
      hold: (message) =>
        message.type === "leave"
          ? new Promise<void>((resolve) => (deliverLeave = resolve))
          : undefined,
    });
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    browser.window.dispatchEvent(new browser.window.Event("pageshow"));
    await quiet();
    expect(sent.map((message) => message.type)).toEqual(["presence", "leave"]);
    deliverLeave();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((message) => message.type)).toEqual([
      "presence",
      "leave",
      "presence",
    ]);
  });

  it("sends presence after a leave that failed, once it has failed", async () => {
    let failLeave!: () => void;
    const { browser, client, sent, quiet } = setup({
      hold: (message) =>
        message.type === "leave"
          ? new Promise<void>(
              (_, reject) => (failLeave = () => reject(new Error("offline"))),
            )
          : undefined,
    });
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    browser.window.dispatchEvent(new browser.window.Event("pageshow"));
    await quiet();
    expect(sent.map((message) => message.type)).toEqual(["presence", "leave"]);
    failLeave();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((message) => message.type)).toEqual([
      "presence",
      "leave",
      "presence",
    ]);
  });
});

describe("createAgentUiClient after leaving", () => {
  it("stays silent about presence while the page is gone, even when focus and visibility change after pagehide", async () => {
    const { browser, client, sent, quiet } = setup();
    client.opened();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(false);
    browser.window.dispatchEvent(new browser.window.Event("blur"));
    browser.document.dispatchEvent(new browser.window.Event("visibilitychange"));
    await quiet();
    expect(sent.map((message) => message.type)).toEqual(["presence", "leave"]);
  });
});

describe("createAgentUiClient navigate", () => {
  async function routed(settled = async () => {}) {
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
      answered: (count: number) => vi.waitFor(() => expect(sent).toHaveLength(count)),
      quiet: () => new Promise((r) => setTimeout(r, 20)),
    };
  }

  it("navigates to a route with params and returns the new screen", async () => {
    const settled = vi.fn(async () => {});
    const { client, router, sent, answered } = await routed(settled);
    client.receive(
      request("n1", "navigate", { to: "/tasks/$taskId", params: { taskId: "t1" } }),
    );
    await answered(1);
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
    const { browser, client, router, sent, answered, quiet } = await routed();
    const element = browser.document.createElement("li");
    browser.document.body.appendChild(element);
    browser.setRect(element, 0, 30);
    const slot = client.views.track(row, { key: "r0", get: () => ({ n: 0 }) });
    slot.ref(element);
    slot.mount("r0");
    vi.spyOn(browser.env, "setTimeout").mockReturnValue(0 as never);
    client.receive(request("n3", "navigate", { to: "/settings" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    await quiet();
    expect(sent).toEqual([]);
    browser.intersect(element, true);
    await answered(1);
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
    const { client, router, sent, answered } = await routed();
    client.receive(request("n2", "navigate", { to: "/nope" }));
    await answered(1);
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

describe("createAgentUiClient watch", () => {
  const presences = (sent: ClientMessage[]) =>
    sent.flatMap((m) => (m.type === "presence" ? [m.watching] : []));

  it("reports the watched threads in presence and stops when the last watcher leaves", async () => {
    const { browser, client, sent } = setup();
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
    client.opened();
    await vi.waitFor(() => expect(presences(sent)).toEqual([undefined]));

    const stopOne = client.watch("thr_1");
    const stopTwo = client.watch("thr_2");
    await vi.waitFor(() => expect(presences(sent).at(-1)).toEqual(["thr_1", "thr_2"]));

    stopOne();
    await vi.waitFor(() => expect(presences(sent).at(-1)).toEqual(["thr_2"]));
    stopTwo();
    await vi.waitFor(() => expect(presences(sent).at(-1)).toBeUndefined());
    expect(presences(sent)).toEqual([
      undefined,
      ["thr_1", "thr_2"],
      ["thr_2"],
      undefined,
    ]);
  });

  it("keeps a thread watched until every watcher of it has stopped", async () => {
    const { browser, client, sent } = setup();
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
    client.opened();
    const first = client.watch("thr_1");
    const second = client.watch("thr_1");
    await vi.waitFor(() => expect(presences(sent).at(-1)).toEqual(["thr_1"]));
    first();
    first();
    await client.screen();
    expect(presences(sent).at(-1)).toEqual(["thr_1"]);
    second();
    await vi.waitFor(() => expect(presences(sent).at(-1)).toBeUndefined());
  });

  it("names at most 8 threads, so presence is never refused for watching too many", async () => {
    const { browser, client, sent } = setup();
    vi.spyOn(browser.document, "hasFocus").mockReturnValue(true);
    client.opened();
    for (let n = 1; n <= 9; n++) client.watch(`thr_${n}`);
    await vi.waitFor(() =>
      expect(presences(sent).at(-1)).toEqual([
        "thr_1",
        "thr_2",
        "thr_3",
        "thr_4",
        "thr_5",
        "thr_6",
        "thr_7",
        "thr_8",
      ]),
    );
  });
});
