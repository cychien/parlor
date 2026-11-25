import { describe, expect, it } from "vitest";

import { catalogsOf, findPages, MAX_PAGES_LISTED } from "./catalog.js";
import type { UiManifest } from "./manifest.js";
import { createUiTools } from "./server/tools.js";

const manifest: UiManifest = {
  protocol: 1,
  app: { name: "Tasks" },
  routes: [
    {
      path: "/",
      description: "Home: the task list and the New task form",
      params: [],
      views: ["newTask", "task"],
    },
    {
      path: "/tasks/$taskId",
      description: "One task with its notes",
      params: ["taskId"],
      search: { type: "object", properties: { tab: { enum: ["notes", "history"] } } },
      views: ["task"],
    },
    { path: "/settings", description: "Account settings", params: [], views: [] },
  ],
  views: [
    {
      name: "newTask",
      description: "The New task form",
      keyed: false,
      writable: ["title", "notes"],
    },
    { name: "task", description: "A task", keyed: true, writable: [] },
  ],
};

describe("catalogsOf", () => {
  it("lists pages, views and forms in full within the budget", () => {
    expect(catalogsOf(manifest)).toEqual({
      views:
        "\n\nViews this app can show:\n- newTask: The New task form.\n- task (keyed): A task.",
      routes:
        '\n\nPages:\n- / - Home: the task list and the New task form. Views: newTask, task.\n- /tasks/$taskId - One task with its notes. Search: tab?: "notes" | "history". Views: task.\n- /settings - Account settings.',
      writable:
        "\n\nForms you can fill:\n- newTask: The New task form. Fields: title, notes.",
      brief: false,
    });
  });

  it("lists names only past the budget and points at ui_pages", () => {
    expect(catalogsOf(manifest, 100)).toEqual({
      views:
        "\n\nViews this app can show (ui_pages describes them): newTask, task (keyed).",
      routes:
        "\n\nPages: every path to takes. Call ui_pages to find the page for a task; it gives each page's description, search params and views.",
      writable:
        "\n\nForms you can fill, with their fields (ui_pages describes them):\n- newTask: title, notes",
      brief: true,
    });
  });

  it("has nothing to list without a manifest", () => {
    expect(catalogsOf(undefined)).toEqual({
      views: "",
      routes: "",
      writable: "",
      brief: false,
    });
  });
});

describe("findPages", () => {
  it("ranks pages by how many query words their path, description and views mention", () => {
    expect(findPages(manifest, { query: "task notes" })).toEqual({
      pages: [
        {
          path: "/",
          description: "Home: the task list and the New task form",
          views: [
            {
              name: "newTask",
              description: "The New task form",
              fields: ["title", "notes"],
            },
            { name: "task", keyed: true, description: "A task" },
          ],
        },
        {
          path: "/tasks/$taskId",
          description: "One task with its notes",
          params: ["taskId"],
          search: 'tab?: "notes" | "history"',
          views: [{ name: "task", keyed: true, description: "A task" }],
        },
      ],
    });
  });

  it("gives one page by path, every page without a query, and nothing for an unknown word", () => {
    expect(findPages(manifest, { path: "/settings" })).toEqual({
      pages: [{ path: "/settings", description: "Account settings" }],
    });
    expect(findPages(manifest, {}).pages.map((page) => page.path)).toEqual([
      "/",
      "/tasks/$taskId",
      "/settings",
    ]);
    expect(findPages(manifest, { query: "billing" })).toEqual({ pages: [] });
    expect(
      findPages(manifest, { query: "forms" }).pages.map((page) => page.path),
    ).toEqual(["/"]);
  });

  it("lists at most ten pages and counts the rest", () => {
    const many: UiManifest = {
      ...manifest,
      routes: Array.from({ length: 13 }, (_, n) => ({
        path: `/report/${n}`,
        description: "A report",
        params: [],
        views: [],
      })),
    };
    const result = findPages(many, { query: "report" });
    expect(result.pages).toHaveLength(MAX_PAGES_LISTED);
    expect(result.more).toBe(3);
  });
});

describe("ui_pages", () => {
  const toolsFor = createUiTools({ directory: {} as never, broker: {} as never });
  const names = (m: UiManifest) => toolsFor(m).map((tool) => tool.name);

  it("joins the ui_ tools only when the catalog is past the budget", () => {
    expect(names(manifest)).toEqual([
      "ui_screen",
      "ui_navigate",
      "ui_set",
      "ui_highlight",
    ]);
    const large: UiManifest = {
      ...manifest,
      routes: Array.from({ length: 80 }, (_, n) => ({
        path: `/admin/section-${n}`,
        description:
          "An admin section with a long description of everything it shows and edits",
        params: [],
        views: [],
      })),
    };
    expect(names(large)).toEqual([
      "ui_screen",
      "ui_navigate",
      "ui_set",
      "ui_highlight",
      "ui_pages",
    ]);
  });
});
