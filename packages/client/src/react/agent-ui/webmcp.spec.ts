import type { UiManifest, UiReply } from "@parlor/agent-ui";
import type { AgentUiClient } from "@parlor/agent-ui/client";
import { uiToolSpecs } from "@parlor/agent-ui/server";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../../action-client.js";
import {
  type ModelContext,
  modelContextOf,
  startWebMcp,
  type WebMcpTool,
} from "./webmcp.js";

const ui: UiManifest = {
  protocol: 1,
  app: { name: "Tasks" },
  routes: [{ path: "/", description: "Home", params: [], views: ["newTask"] }],
  views: [
    {
      name: "newTask",
      description: "The New task form",
      keyed: false,
      writable: ["title"],
    },
  ],
};

const manifest = {
  actions: [
    {
      name: "listTasks",
      description: "List tasks.",
      mutating: false,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "deleteTask",
      description: "Delete a task.",
      mutating: true,
      confirm: true,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    },
  ],
  ui,
  uiTools: uiToolSpecs(ui, "page").map(({ input: _input, ...spec }) => spec),
};

function setup(answers: Record<string, Response> = {}) {
  const requests: { path: string; init: RequestInit | undefined }[] = [];
  const client = {
    basePath: "/_parlor",
    request: vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      if (path === "/_parlor/manifest") return Response.json(manifest);
      return answers[path] ?? Response.json({ data: { ok: true }, tags: [] });
    }),
  } as unknown as ActionClient<never>;
  const performed: unknown[][] = [];
  const replies: Partial<Record<string, UiReply>> = {};
  const agentUi = {
    perform: vi.fn(async (op: string, input: unknown, origin: unknown) => {
      performed.push([op, input, origin]);
      return replies[op] ?? { type: "reply", id: "x", ok: true, result: {} };
    }),
  } as unknown as AgentUiClient;
  const tools = new Map<string, WebMcpTool>();
  const unregistered: string[] = [];
  let registrations = 0;
  const context: ModelContext = {
    registerTool: (tool) => {
      registrations += 1;
      tools.set(tool.name, tool);
    },
    unregisterTool: (name) => {
      unregistered.push(name);
    },
  };
  return {
    client,
    agentUi,
    context,
    tools,
    unregistered,
    requests,
    performed,
    replies,
    registrations: () => registrations,
  };
}

const registered = (tools: Map<string, WebMcpTool>, count: number) =>
  vi.waitFor(() => expect(tools.size).toBe(count));

describe("startWebMcp", () => {
  it("registers every action the manifest lists and the page's ui_ tools", async () => {
    const { client, agentUi, context, tools } = setup();
    startWebMcp(client, agentUi, context);
    await registered(tools, 6);
    expect([...tools.keys()]).toEqual([
      "listTasks",
      "deleteTask",
      "ui_screen",
      "ui_navigate",
      "ui_set",
      "ui_highlight",
    ]);
    expect(tools.get("listTasks")).toMatchObject({
      description: "List tasks.",
      annotations: { readOnlyHint: true },
    });
    expect(tools.get("deleteTask")?.description).toBe(
      "Delete a task. When an agent calls it, the user must approve it in the app first; the call waits for that answer and fails with declined, confirmation_timeout or confirmation_unavailable without running.",
    );
    expect(tools.get("ui_screen")?.description).not.toContain("reachable");
    expect(tools.get("ui_set")?.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
  });

  it("runs an action as an agent's call, so its approval applies, and answers errors in the MCP body", async () => {
    const { client, agentUi, context, tools, requests } = setup({
      "/_parlor/actions/deleteTask": Response.json(
        { error: { code: "declined", message: "The user declined." } },
        { status: 403 },
      ),
    });
    startWebMcp(client, agentUi, context);
    await registered(tools, 6);
    expect(await tools.get("listTasks")!.execute({})).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      structuredContent: { ok: true },
    });
    const call = requests.find(
      (request) => request.path === "/_parlor/actions/listTasks",
    );
    expect(new Headers(call?.init?.headers).get("x-parlor-source")).toBe("mcp");
    expect(await tools.get("deleteTask")!.execute({ id: "t1" })).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '{"error":{"code":"declined","message":"The user declined."}}',
        },
      ],
    });
  });

  it("runs ui_ tools in the page as the browser agent and leaves out what a screen says nothing with", async () => {
    const { client, agentUi, context, tools, performed, replies } = setup();
    replies.screen = {
      type: "reply",
      id: "x",
      ok: true,
      result: {
        route: { notFound: false, path: "/", params: {}, search: {}, url: "/" },
        queries: [],
        views: {},
        attention: {
          focus: null,
          selection: null,
          lastInteracted: null,
          lastEntered: null,
          focal: null,
        },
        truncated: false,
      },
    };
    replies.set = {
      type: "reply",
      id: "x",
      ok: false,
      error: {
        code: "not_mounted",
        message: "newTask is not on screen. On screen now: none.",
      },
    };
    startWebMcp(client, agentUi, context);
    await registered(tools, 6);
    expect((await tools.get("ui_screen")!.execute({})).structuredContent).toEqual({
      route: { path: "/", url: "/" },
    });
    expect(
      await tools.get("ui_set")!.execute({ view: "newTask", value: { title: "x" } }),
    ).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '{"error":{"code":"not_mounted","message":"newTask is not on screen. On screen now: none."}}',
        },
      ],
    });
    expect(await tools.get("ui_set")!.execute({ view: 3 })).toMatchObject({
      isError: true,
    });
    expect(performed).toEqual([
      ["screen", {}, { via: "mcp", name: "Browser agent" }],
      [
        "set",
        { view: "newTask", value: { title: "x" } },
        { via: "mcp", name: "Browser agent" },
      ],
    ]);
  });

  it("takes every tool back when it stops, and registers them again for a new user on refresh", async () => {
    const { client, agentUi, context, tools, unregistered, registrations } = setup();
    const webMcp = startWebMcp(client, agentUi, context);
    await registered(tools, 6);
    webMcp.refresh();
    expect(unregistered).toEqual([...tools.keys()]);
    await vi.waitFor(() => expect(registrations()).toBe(12));
    webMcp.stop();
    expect(unregistered).toEqual([...tools.keys(), ...tools.keys()]);
  });

  it("does nothing in a browser without WebMCP, and registers nothing when the manifest is refused", async () => {
    const { client, agentUi } = setup();
    startWebMcp(client, agentUi, undefined).stop();
    expect(client.request).not.toHaveBeenCalled();
    const refused = setup();
    (refused.client.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("{}", { status: 401 }),
    );
    startWebMcp(refused.client, refused.agentUi, refused.context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refused.tools.size).toBe(0);
  });
});

describe("modelContextOf", () => {
  const context = { registerTool: () => {} };
  it("prefers document.modelContext, falls back to navigator.modelContext, and needs registerTool", () => {
    expect(modelContextOf({ document: { modelContext: context } })).toBe(context);
    expect(modelContextOf({ document: {}, navigator: { modelContext: context } })).toBe(
      context,
    );
    expect(modelContextOf({ document: { modelContext: {} } })).toBeUndefined();
    expect(modelContextOf({})).toBeUndefined();
  });
});
