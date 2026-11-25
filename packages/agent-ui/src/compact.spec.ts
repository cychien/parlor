import { describe, expect, it } from "vitest";

import { compactClient, compactScreen } from "./compact.js";
import type { ClientSummary, ScreenSnapshot } from "./protocol.js";

const empty: ScreenSnapshot = {
  route: { notFound: false, path: "/", params: {}, search: {}, url: "/" },
  queries: [{ action: "listTasks", input: {}, status: "success" }],
  views: {
    newTask: { value: { title: "", notes: "" }, shown: 1 },
    agentPanel: { value: { open: false }, shown: 0 },
    task: {
      items: [
        { key: "t1", value: { title: "Buy milk", done: false }, shown: 1 },
        { key: "t2", value: { title: "Call Amy", done: true }, shown: 0.4 },
      ],
      offscreen: 0,
    },
  },
  attention: {
    focus: null,
    selection: null,
    lastInteracted: null,
    lastEntered: null,
    focal: { view: "task", key: "t1" },
  },
  truncated: false,
};

describe("compactScreen", () => {
  it("leaves out empty params, search and input, success statuses, null attention, zero offscreen and full visibility", () => {
    expect(compactScreen(empty)).toEqual({
      route: { path: "/", url: "/" },
      queries: [{ action: "listTasks" }],
      views: {
        newTask: { value: { title: "", notes: "" } },
        agentPanel: { value: { open: false }, shown: 0 },
        task: {
          items: [
            { key: "t1", value: { title: "Buy milk", done: false } },
            { key: "t2", value: { title: "Call Amy", done: true }, shown: 0.4 },
          ],
        },
      },
      attention: { focal: { view: "task", key: "t1" } },
    });
  });

  it("keeps what carries information", () => {
    const busy: ScreenSnapshot = {
      route: {
        notFound: false,
        path: "/tasks/$taskId",
        params: { taskId: "t1" },
        search: { tab: "notes" },
        url: "/tasks/t1?tab=notes",
      },
      queries: [{ action: "getTask", input: { id: "t1" }, status: "pending" }],
      views: { task: { items: [], offscreen: 12 } },
      attention: {
        focus: { view: "task", key: "t1", field: "title" },
        selection: {
          text: "milk",
          within: { view: "task", key: "t1" },
          truncated: false,
        },
        lastInteracted: null,
        lastEntered: null,
        focal: null,
      },
      truncated: true,
    };
    expect(compactScreen(busy)).toEqual({
      route: {
        path: "/tasks/$taskId",
        url: "/tasks/t1?tab=notes",
        params: { taskId: "t1" },
        search: { tab: "notes" },
      },
      queries: [{ action: "getTask", input: { id: "t1" }, status: "pending" }],
      views: { task: { items: [], offscreen: 12 } },
      attention: {
        focus: { view: "task", key: "t1", field: "title" },
        selection: {
          text: "milk",
          within: { view: "task", key: "t1" },
          truncated: false,
        },
      },
      truncated: true,
    });
  });

  it("gives a not-found route as notFound and url only, and drops an absent route and empty sections", () => {
    expect(
      compactScreen({
        ...empty,
        route: { notFound: true, url: "/nowhere" },
        queries: [],
        views: {},
        attention: {
          focus: null,
          selection: null,
          lastInteracted: null,
          lastEntered: null,
          focal: null,
        },
      }),
    ).toEqual({ route: { notFound: true, url: "/nowhere" } });
    expect(compactScreen({ ...empty, route: null, queries: [], views: {} })).toEqual({
      attention: { focal: { view: "task", key: "t1" } },
    });
  });

  it("reads sections an older client leaves out as empty", () => {
    expect(compactScreen({ route: null })).toEqual({});
    expect(
      compactScreen({
        route: { notFound: false, path: "/", url: "/" } as never,
        views: {},
      }),
    ).toEqual({ route: { path: "/", url: "/" } });
  });
});

describe("compactClient", () => {
  const summary: ClientSummary = {
    id: "tab-1",
    platform: "web",
    focused: true,
    visible: false,
    seenAgoMs: 420,
  };

  it("drops the id and age of the only client", () => {
    expect(compactClient(summary, true)).toEqual({
      platform: "web",
      focused: true,
      visible: false,
    });
  });

  it("keeps the id and age when other clients are open", () => {
    expect(compactClient({ ...summary, buildId: "b7" }, false)).toEqual({
      id: "tab-1",
      platform: "web",
      buildId: "b7",
      focused: true,
      visible: false,
      seenAgoMs: 420,
    });
  });
});
