import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type ActionMap, type DataProvider, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createServer,
  type FrameworkServer,
  type ServerOptions,
} from "./create-server.js";

const actions = createRegistry({
  hello: defineAction({
    description: "Say hello.",
    input: z.object({}),
    run: () => ({ message: "hi" }),
  }),
});

const screen = (path: string) => ({
  route: { notFound: false, path, params: {}, search: {}, url: path },
  queries: [{ action: "hello", input: {} }],
  views: {},
  attention: {
    focus: null,
    selection: null,
    lastInteracted: null,
    lastEntered: null,
    focal: null,
  },
  truncated: false,
});

const ALL_OPS = ["screen", "navigate", "set", "highlight"];

let database: DatabaseHandle;
let server: FrameworkServer;
const closers: (() => Promise<void> | void)[] = [];

const lend = (owner: DatabaseHandle): DataProvider => ({
  read: () => owner.read(),
  transaction: (run) => owner.transaction(run),
  listen: (channel, handler) => owner.listen(channel, handler),
});

const uiManifest = {
  protocol: 1 as const,
  app: { id: "dev.parlor.test", name: "Test" },
  routes: [
    { path: "/", description: "Home with tasks.", params: [], views: ["task"] },
    { path: "/settings", description: "App settings.", params: [], views: [] },
    {
      path: "/tasks/$taskId",
      description: "One task.",
      params: ["taskId"],
      views: ["task"],
    },
  ],
  views: [
    {
      name: "task",
      description: "A task row; the key is the task id.",
      keyed: true,
      schema: { type: "object" },
      writable: [],
    },
    {
      name: "newTask",
      description: "The New task form.",
      keyed: false,
      schema: { type: "object" },
      writable: ["title", "notes"],
    },
  ],
};

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  server = createServer({ actions, database, agentUi: { timeoutMs: 2000 } });
  server.installUiManifest?.(() => uiManifest);
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
afterAll(async () => {
  await server.close();
  await database.close();
});

function post(target: FrameworkServer, path: string, body: unknown, clientId?: string) {
  return target.fetch(
    new Request(`http://app.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(clientId ? { "x-parlor-client": clientId } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function openBrowser(
  id: string,
  path: string,
  target = server,
  answering: Promise<void> = Promise.resolve(),
) {
  const controller = new AbortController();
  const response = await target.fetch(
    new Request("http://app.test/_parlor/sync/stream?since=", {
      headers: { "x-parlor-client": id, accept: "text/event-stream" },
      signal: controller.signal,
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const requests: unknown[] = [];
  const via: ("stream" | "reply")[] = [];
  const lists: {
    id: string;
    action: string;
    description: string;
    input: unknown;
    origin: unknown;
  }[][] = [];
  let buffer = "";
  let handshake!: () => void;
  const ready = new Promise<void>((resolve) => (handshake = resolve));
  const answer = async (data: string, channel: "stream" | "reply"): Promise<void> => {
    const frame = JSON.parse(data) as { type?: string; items?: (typeof lists)[number] };
    if (frame.type === "confirmations") {
      lists.push(frame.items ?? []);
      return;
    }
    const request = frame as unknown as {
      id: string;
      op: string;
      input: { to?: string; value?: Record<string, unknown> };
    };
    requests.push(request);
    via.push(channel);
    await answering;
    const result =
      request.op === "navigate"
        ? { screen: screen(request.input.to ?? "") }
        : request.op === "set"
          ? {
              value: request.input.value,
              agentFields: Object.keys(request.input.value ?? {}),
            }
          : request.op === "highlight"
            ? { shown: 1 }
            : screen(path);
    const answered = await post(
      target,
      "/_parlor/ui",
      { type: "reply", id: request.id, ok: true, result },
      id,
    );
    if (answered.status === 200) await answer(await answered.text(), "reply");
  };
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader
        .read()
        .catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("event: handshake")) handshake();
        if (!frame.startsWith("event: ui\n")) continue;
        await answer(frame.slice(frame.indexOf("data:") + 5), "stream");
      }
    }
  })();
  await ready;
  closers.push(async () => {
    controller.abort();
    await reader.cancel().catch(() => {});
    await pump;
  });
  const answerCard = (cardId: string, approve: boolean) =>
    post(target, "/_parlor/ui", { type: "answer", id: cardId, approve }, id);
  return {
    requests,
    via,
    shown: () => lists.at(-1) ?? [],
    lists,
    approve: (cardId: string) => answerCard(cardId, true),
    decline: (cardId: string) => answerCard(cardId, false),
    presence: (
      focused: boolean,
      visible: boolean,
      platform = "web",
      canConfirm = true,
      ops: readonly string[] | null = ALL_OPS,
    ) =>
      post(
        target,
        "/_parlor/ui",
        {
          type: "presence",
          focused,
          visible,
          platform,
          canConfirm,
          ...(ops ? { ops } : {}),
        },
        id,
      ),
    leave: () => post(target, "/_parlor/ui", { type: "leave" }, id),
  };
}

async function openStream(id: string) {
  const controller = new AbortController();
  const response = await server.fetch(
    new Request("http://app.test/_parlor/sync/stream?since=", {
      headers: { "x-parlor-client": id, accept: "text/event-stream" },
      signal: controller.signal,
    }),
  );
  const reader = response.body!.getReader();
  await reader.read();
  closers.push(async () => {
    controller.abort();
    await reader.cancel().catch(() => {});
  });
}

async function openSilentBrowser(id: string) {
  await openStream(id);
  const presence = { type: "presence", focused: true, visible: true, platform: "web" };
  await post(server, "/_parlor/ui", presence, id);
  return { leave: () => post(server, "/_parlor/ui", { type: "leave" }, id) };
}

async function mcp(target = server, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/_parlor/mcp"), {
      requestInit: { headers },
      fetch: (input, init) => target.fetch(new Request(input, init)),
    }),
  );
  closers.push(() => client.close());
  return client;
}

describe("agent UI over MCP", () => {
  it("lists the UI tools next to the actions", async () => {
    const { tools } = await (await mcp()).listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "hello",
      "ui_screen",
      "ui_navigate",
      "ui_set",
      "ui_highlight",
    ]);
    const uiScreen = tools.find((t) => t.name === "ui_screen");
    expect(uiScreen?.annotations?.readOnlyHint).toBe(true);
    expect(uiScreen?.inputSchema).toMatchObject({
      type: "object",
      properties: { clientId: { type: "string" } },
    });
  });

  it("puts the view catalog in ui_screen and the route catalog in ui_navigate", async () => {
    const { tools } = await (await mcp()).listTools();
    const uiScreen = tools.find((t) => t.name === "ui_screen");
    const uiNavigate = tools.find((t) => t.name === "ui_navigate");
    expect(uiScreen?.description).toContain(
      "- task (keyed): A task row; the key is the task id.",
    );
    expect(uiNavigate?.description).toContain("- / - Home with tasks. Views: task.");
    expect(uiNavigate?.description).toContain("- /settings - App settings.");
    expect(uiNavigate?.description).toContain(
      "- /tasks/$taskId - One task. Views: task.",
    );
    expect(uiNavigate?.annotations?.readOnlyHint).toBe(false);
    expect(uiNavigate?.inputSchema).toMatchObject({
      properties: { to: { type: "string", enum: ["/", "/settings", "/tasks/$taskId"] } },
      required: ["to"],
    });
  });

  it("describes ui_set with the forms it can fill and says the user submits them", async () => {
    const { tools } = await (await mcp()).listTools();
    const uiSet = tools.find((t) => t.name === "ui_set");
    expect(uiSet?.annotations?.readOnlyHint).toBe(false);
    expect(uiSet?.description).toContain("the user reviews it and submits it themselves");
    expect(uiSet?.description).toContain(
      "- newTask: The New task form. Fields: title, notes.",
    );
    expect(uiSet?.description).not.toContain("- task (keyed)");
    expect(uiSet?.inputSchema).toMatchObject({
      required: ["view", "value"],
      properties: { view: { type: "string" }, key: { type: "string" } },
    });
  });

  it("keeps serving MCP when the installed manifest predates writable views", async () => {
    const target = createServer({ actions, database: lend(database) });
    closers.push(() => target.close());
    target.installUiManifest?.(() => ({
      protocol: 1,
      app: { id: "dev.parlor.test", name: "Test" },
      routes: [{ path: "/", params: [], views: ["form", "profile"] }],
      views: [
        { name: "form", description: "A form.", keyed: false },
        { name: "profile", description: "A profile.", keyed: false, writable: ["name"] },
      ],
    }));
    const client = await mcp(target);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "hello",
      "ui_screen",
      "ui_navigate",
      "ui_set",
      "ui_highlight",
    ]);
    const description = tools.find((t) => t.name === "ui_set")?.description;
    expect(description).toContain("- profile: A profile. Fields: name.");
    expect(description).not.toContain("- form:");
    expect((await client.callTool({ name: "hello", arguments: {} })).isError).toBeFalsy();
  });

  it("describes ui_highlight and keeps it out of the read-only set", async () => {
    const { tools } = await (await mcp()).listTools();
    const uiHighlight = tools.find((t) => t.name === "ui_highlight");
    expect(uiHighlight?.annotations?.readOnlyHint).toBe(false);
    expect(uiHighlight?.description).toContain("into the middle of the screen");
    expect(uiHighlight?.description).toContain("for two seconds");
    expect(uiHighlight?.inputSchema).toMatchObject({
      required: ["view"],
      properties: { field: { type: "string" }, key: { type: "string" } },
    });
  });

  it("keeps serving MCP when the installed manifest predates writable views", async () => {
    const target = createServer({ actions, database: lend(database) });
    closers.push(() => target.close());
    target.installUiManifest?.(() => ({
      protocol: 1,
      app: { id: "dev.parlor.test", name: "Test" },
      routes: [{ path: "/", params: [], views: ["form"] }],
      views: [{ name: "form", description: "A form.", keyed: false }],
    }));
    const client = await mcp(target);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "hello",
      "ui_screen",
      "ui_navigate",
      "ui_set",
      "ui_highlight",
    ]);
    expect(tools.find((t) => t.name === "ui_set")?.description).not.toContain(
      "Forms you can fill",
    );
    expect((await client.callTool({ name: "hello", arguments: {} })).isError).toBeFalsy();
  });

  it("serves the full manifest as an MCP resource and over HTTP", async () => {
    const client = await mcp();
    const resource = await client.readResource({ uri: "parlor://manifest" });
    expect(JSON.parse(String((resource.contents[0] as { text: string }).text))).toEqual(
      uiManifest,
    );
    const response = await server.fetch(new Request("http://app.test/_parlor/manifest"));
    expect(await response.json()).toMatchObject({
      protocol: 1,
      actions: [{ name: "hello" }],
      ui: uiManifest,
    });
  });

  it("navigates the selected client and returns the new screen", async () => {
    const tab = await openBrowser("tab-n", "/");
    await tab.presence(true, true);
    const result = await (
      await mcp()
    ).callTool({
      name: "ui_navigate",
      arguments: { to: "/tasks/$taskId", params: { taskId: "t1" } },
    });
    expect(result.structuredContent).toMatchObject({
      client: { id: "tab-n" },
      screen: { route: { path: "/tasks/$taskId" } },
    });
    expect(tab.requests).toEqual([
      expect.objectContaining({
        op: "navigate",
        input: { to: "/tasks/$taskId", params: { taskId: "t1" } },
      }),
    ]);
  });

  it("refuses to guess between tied clients and to navigate without params", async () => {
    const a = await openBrowser("tab-x", "/");
    const b = await openBrowser("tab-y", "/");
    await Promise.all([a.presence(true, true), b.presence(true, true)]);
    const client = await mcp();
    const tied = await client.callTool({
      name: "ui_navigate",
      arguments: { to: "/settings" },
    });
    expect(tied.isError).toBe(true);
    expect(JSON.parse((tied.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "ambiguous_client" },
    });
    const missing = await client.callTool({
      name: "ui_navigate",
      arguments: { to: "/tasks/$taskId", clientId: "tab-x" },
    });
    expect(JSON.parse((missing.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "unknown_route", issues: [{ path: "params.taskId" }] },
    });
    expect(a.requests).toEqual([]);
  });

  it("writes to the selected client and returns what it read back with the client", async () => {
    const tab = await openBrowser("tab-s", "/");
    await tab.presence(true, true);
    const result = await (
      await mcp()
    ).callTool({
      name: "ui_set",
      arguments: { view: "newTask", value: { title: "Buy stamps" } },
    });
    expect(result.structuredContent).toEqual({
      client: expect.objectContaining({ id: "tab-s" }),
      value: { title: "Buy stamps" },
      agentFields: ["title"],
    });
    expect(tab.requests).toEqual([
      expect.objectContaining({
        op: "set",
        input: { view: "newTask", value: { title: "Buy stamps" } },
      }),
    ]);
  });

  it("refuses ui_set and ui_highlight with unsupported_op for an app that predates them, and keeps screen and navigate working", async () => {
    const tab = await openBrowser("old-tab", "/");
    await tab.presence(true, true, "tauri", false, null);
    const client = await mcp();
    const refusals = await Promise.all([
      client.callTool({
        name: "ui_set",
        arguments: { view: "newTask", value: { title: "x" } },
      }),
      client.callTool({ name: "ui_highlight", arguments: { view: "newTask" } }),
    ]);
    const errors = refusals.map((result) => {
      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      return (JSON.parse(text) as { error: { code: string; message: string } }).error;
    });
    expect(errors.map((error) => error.code)).toEqual([
      "unsupported_op",
      "unsupported_op",
    ]);
    expect(errors[0]!.message).toContain("ui_set");
    expect(errors[1]!.message).toContain("ui_highlight");
    for (const error of errors) expect(error.message).toContain("old-tab");
    const read = await client.callTool({ name: "ui_screen", arguments: {} });
    expect(read.isError).toBeFalsy();
    const navigated = await client.callTool({
      name: "ui_navigate",
      arguments: { to: "/settings" },
    });
    expect(navigated.isError).toBeFalsy();
    expect(tab.requests.map((request) => (request as { op: string }).op)).toEqual([
      "screen",
      "navigate",
    ]);
  });

  it("points at a view on the selected client and refuses to guess between tied clients", async () => {
    const client = await mcp();
    const tab = await openBrowser("tab-h", "/");
    await tab.presence(true, true);
    const result = await client.callTool({
      name: "ui_highlight",
      arguments: { view: "task", key: "t1", field: "notes" },
    });
    expect(result.structuredContent).toEqual({
      client: expect.objectContaining({ id: "tab-h" }),
      shown: 1,
    });
    expect(tab.requests).toEqual([
      expect.objectContaining({
        op: "highlight",
        input: { view: "task", key: "t1", field: "notes" },
      }),
    ]);
    const other = await openBrowser("tab-i", "/");
    await other.presence(true, true);
    const tied = await client.callTool({
      name: "ui_highlight",
      arguments: { view: "task" },
    });
    expect(JSON.parse((tied.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "ambiguous_client" },
    });
  });

  it("refuses to write to one of several tied clients and answers no_client when none is open", async () => {
    const client = await mcp();
    const none = await client.callTool({
      name: "ui_set",
      arguments: { view: "newTask", value: { title: "x" } },
    });
    expect(none.structuredContent).toEqual({ reachable: false, reason: "no_client" });
    const a = await openBrowser("tab-p", "/");
    const b = await openBrowser("tab-q", "/");
    await Promise.all([a.presence(true, true), b.presence(true, true)]);
    const tied = await client.callTool({
      name: "ui_set",
      arguments: { view: "newTask", value: { title: "x" } },
    });
    expect(tied.isError).toBe(true);
    expect(JSON.parse((tied.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "ambiguous_client" },
    });
    expect([...a.requests, ...b.requests]).toEqual([]);
  });

  it("returns a link instead of navigating when no app is open", async () => {
    const result = await (
      await mcp()
    ).callTool({
      name: "ui_navigate",
      arguments: { to: "/tasks/$taskId", params: { taskId: "t 1" } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      reachable: false,
      reason: "no_client",
      href: "http://app.test/tasks/t%201",
    });
  });

  it("answers bad arguments to a ui_ tool in the same error body as every other failure", async () => {
    const client = await mcp();
    const result = await client.callTool({
      name: "ui_set",
      arguments: { value: { title: "x" } },
    });
    expect(result.isError).toBe(true);
    expect(
      JSON.parse((result.content as { text: string }[])[0]!.text) as unknown,
    ).toEqual({
      error: {
        code: "invalid_input",
        message: 'Invalid input for "ui_set"',
        issues: [{ path: "view", message: expect.any(String) }],
      },
    });
  });

  it("explains the conventions in the server instructions", async () => {
    const client = await mcp();
    expect(client.getInstructions()).toContain("attention");
    expect(client.getInstructions()).toContain(
      "You fill forms and the user submits them",
    );
  });

  it("answers no_client without an error when no app is open", async () => {
    const result = await (await mcp()).callTool({ name: "ui_screen", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ reachable: false, reason: "no_client" });
  });

  it("asks the connected browser for its screen and names the client", async () => {
    const tab = await openBrowser("tab-a", "/");
    await tab.presence(false, true);
    const result = await (await mcp()).callTool({ name: "ui_screen", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      ...screen("/"),
      client: { id: "tab-a", platform: "web", focused: false, visible: true },
      otherClients: [],
    });
    expect(tab.requests).toEqual([
      expect.objectContaining({ op: "screen", input: {}, origin: { via: "mcp" } }),
    ]);
  });

  it("hands concurrent requests to one client one at a time, each in the previous reply's response", async () => {
    let release!: () => void;
    const tab = await openBrowser(
      "tab-c",
      "/",
      server,
      new Promise<void>((resolve) => (release = resolve)),
    );
    await tab.presence(true, true);
    const client = await mcp();
    const calls = Array.from({ length: 5 }, () =>
      client.callTool({ name: "ui_screen", arguments: {} }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(tab.via).toEqual(["stream"]);
    release();
    const results = await Promise.all(calls);
    expect(results.map((result) => result.isError ?? false)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(tab.via).toEqual(["stream", "reply", "reply", "reply", "reply"]);
  });

  it("prefers the focused client and honours an explicit client id", async () => {
    const a = await openBrowser("tab-a", "/");
    const b = await openBrowser("tab-b", "/settings");
    await a.presence(false, true);
    await b.presence(true, true);
    const client = await mcp();
    const auto = await client.callTool({ name: "ui_screen", arguments: {} });
    expect(auto.structuredContent).toMatchObject({
      route: { path: "/settings" },
      client: { id: "tab-b" },
      otherClients: [{ id: "tab-a" }],
    });
    const explicit = await client.callTool({
      name: "ui_screen",
      arguments: { clientId: "tab-a" },
    });
    expect(explicit.structuredContent).toMatchObject({
      route: { path: "/" },
      client: { id: "tab-a" },
    });
  });

  it("treats an action call from a client as that client being seen", async () => {
    const a = await openBrowser("tab-a", "/");
    const b = await openBrowser("tab-b", "/settings");
    await a.presence(false, false);
    await new Promise((r) => setTimeout(r, 5));
    await b.presence(false, false);
    await new Promise((r) => setTimeout(r, 5));
    await post(server, "/_parlor/actions/hello", {}, "tab-a");
    const result = await (await mcp()).callTool({ name: "ui_screen", arguments: {} });
    expect(result.structuredContent).toMatchObject({ client: { id: "tab-a" } });
  });
});

describe("clients built without agent UI", () => {
  it("never targets a stream that did not announce agent UI, even after it runs an action", async () => {
    const tab = await openBrowser("tab-new", "/settings");
    await tab.presence(false, false);
    await openStream("old-desktop");
    await new Promise((r) => setTimeout(r, 5));
    await post(server, "/_parlor/actions/hello", {}, "old-desktop");
    const client = await mcp();
    const started = Date.now();
    const result = await client.callTool({ name: "ui_screen", arguments: {} });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.structuredContent).toMatchObject({
      route: { path: "/settings" },
      client: { id: "tab-new" },
      otherClients: [],
    });
    const explicit = await client.callTool({
      name: "ui_screen",
      arguments: { clientId: "old-desktop" },
    });
    expect(JSON.parse((explicit.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "unknown_client" },
    });
  });

  it("answers no_client at once when only such a stream is open", async () => {
    await openStream("old-desktop");
    await post(server, "/_parlor/actions/hello", {}, "old-desktop");
    const started = Date.now();
    const result = await (await mcp()).callTool({ name: "ui_screen", arguments: {} });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.structuredContent).toEqual({ reachable: false, reason: "no_client" });
  });
});

describe("clients that are gone", () => {
  it("drops a client that announced it is leaving even while its stream stays open", async () => {
    const live = await openBrowser("tab-live", "/");
    const gone = await openBrowser("tab-gone", "/settings");
    await live.presence(false, false);
    await new Promise((r) => setTimeout(r, 5));
    await gone.presence(true, true);
    expect((await gone.leave()).status).toBe(204);
    const client = await mcp();
    const result = await client.callTool({ name: "ui_screen", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      client: { id: "tab-live" },
      otherClients: [],
    });
  });

  it("fails a request waiting on a client the moment it leaves", async () => {
    const quiet = await openSilentBrowser("tab-quiet");
    const started = Date.now();
    const pending = (await mcp()).callTool({ name: "ui_screen", arguments: {} });
    await new Promise((r) => setTimeout(r, 100));
    await quiet.leave();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "timeout" },
    });
  });

  it("refuses a client id that is not connected instead of picking another client", async () => {
    const tab = await openBrowser("tab-real", "/");
    await tab.presence(false, true);
    const client = await mcp();
    for (const [name, args] of [
      ["ui_screen", { clientId: "does-not-exist" }],
      ["ui_navigate", { to: "/settings", clientId: "does-not-exist" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({
        error: {
          code: "unknown_client",
          message:
            "No app client does-not-exist is connected. Connected clients: tab-real.",
          issues: [{ path: "clientId", message: "tab-real" }],
        },
      });
    }
    expect(tab.requests).toEqual([]);
  });
});

describe("reconnecting clients", () => {
  it("re-sends a waiting request on the stream a client announces after reconnecting", async () => {
    await openSilentBrowser("tab-r");
    const pending = (await mcp()).callTool({ name: "ui_screen", arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    const reopened = await openBrowser("tab-r", "/settings");
    await new Promise((r) => setTimeout(r, 50));
    expect(reopened.requests).toEqual([]);
    await reopened.presence(true, true);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      route: { path: "/settings" },
      client: { id: "tab-r" },
    });
    expect(reopened.requests).toHaveLength(1);
  });
});

describe("unanswered requests", () => {
  it("reports a navigation the app never answered as outcome_unknown", async () => {
    await openSilentBrowser("tab-silent");
    const result = await (
      await mcp()
    ).callTool({
      name: "ui_navigate",
      arguments: { to: "/settings" },
    });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "outcome_unknown" },
    });
  }, 10_000);
});

describe("POST /_parlor/ui", () => {
  it("accepts presence from a connected client", async () => {
    const tab = await openBrowser("tab-p", "/");
    expect((await tab.presence(true, true)).status).toBe(204);
  });

  it("rejects missing client ids, malformed bodies, unknown clients and unknown requests", async () => {
    await openBrowser("tab-q", "/");
    const presence = { type: "presence", focused: true, visible: true, platform: "web" };
    expect((await post(server, "/_parlor/ui", presence)).status).toBe(400);
    expect((await post(server, "/_parlor/ui", "{nope", "tab-q")).status).toBe(400);
    expect((await post(server, "/_parlor/ui", { type: "other" }, "tab-q")).status).toBe(
      400,
    );
    expect((await post(server, "/_parlor/ui", presence, "ghost")).status).toBe(404);
    const reply = { type: "reply", id: "unknown", ok: true, result: null };
    expect((await post(server, "/_parlor/ui", reply, "tab-q")).status).toBe(404);
  });

  it("refuses bodies over 256 KB", async () => {
    const huge = { type: "reply", id: "x", ok: true, result: "x".repeat(300 * 1024) };
    expect((await post(server, "/_parlor/ui", huge, "tab-q")).status).toBe(413);
  });
});

describe("external agent policy", () => {
  const toolNames = async (agentUi: ServerOptions<ActionMap>["agentUi"]) => {
    const target = createServer({ actions, agentUi });
    closers.push(() => target.close());
    const { tools } = await (await mcp(target)).listTools();
    return tools.map((t) => t.name);
  };

  it("exposes UI tools by default, read-only tools for read-only, and none when off", async () => {
    const all = ["hello", "ui_screen", "ui_navigate", "ui_set", "ui_highlight"];
    expect(await toolNames(undefined)).toEqual(all);
    expect(await toolNames({ external: true })).toEqual(all);
    expect(await toolNames({ external: "read-only" })).toEqual(["hello", "ui_screen"]);
    expect(await toolNames({ external: false })).toEqual(["hello"]);
    expect(await toolNames(false)).toEqual(["hello"]);
  });
});

describe("actions that ask the user to confirm", () => {
  const ran: string[] = [];
  const confirmActions = createRegistry({
    hello: defineAction({
      description: "Say hello.",
      input: z.object({}),
      run: () => ({ message: "hi" }),
    }),
    removeNote: defineAction({
      description: "Remove a note.",
      input: z.object({ id: z.string() }),
      confirm: true,
      run: ({ id }) => {
        ran.push(id);
        return { removed: id };
      },
    }),
  });
  const open = (agentUi: ServerOptions<ActionMap>["agentUi"] = {}) => {
    ran.length = 0;
    const target = createServer({
      actions: confirmActions,
      database: lend(database),
      agentUi: { timeoutMs: 2000, confirmTimeoutMs: 600, ...(agentUi || {}) },
    });
    closers.push(() => target.close());
    return target;
  };
  const errorOf = (result: { content?: unknown }) =>
    (
      JSON.parse((result.content as { text: string }[])[0]!.text) as {
        error: { code: string; message: string };
      }
    ).error;
  const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  it("shows a card on the client the user looks at and runs the action once they approve", async () => {
    const target = open();
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const call = (await mcp(target)).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    await settle();
    expect(tab.shown()).toEqual([
      expect.objectContaining({
        action: "removeNote",
        description: "Remove a note.",
        input: { id: "n1" },
        origin: expect.objectContaining({ via: "mcp" }),
      }),
    ]);
    expect(ran).toEqual([]);
    expect((await tab.approve(tab.shown()[0]!.id)).status).toBe(204);
    const result = await call;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ removed: "n1" });
    expect(ran).toEqual(["n1"]);
    await settle();
    expect(tab.shown()).toEqual([]);
  });

  it("fails with declined when the user declines and runs nothing", async () => {
    const target = open();
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const call = (await mcp(target)).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    await settle();
    await tab.decline(tab.shown()[0]!.id);
    const result = await call;
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("declined");
    expect(ran).toEqual([]);
  });

  it("fails with confirmation_timeout when nobody answers, and takes the card away", async () => {
    const target = open({ confirmTimeoutMs: 300 });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const started = Date.now();
    const result = await (
      await mcp(target)
    ).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(errorOf(result).code).toBe("confirmation_timeout");
    await settle();
    expect(tab.shown()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("fails at once with confirmation_unavailable, telling the agent to ask the user, when no app is open", async () => {
    const target = open();
    const started = Date.now();
    const result = await (
      await mcp(target)
    ).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(errorOf(result).code).toBe("confirmation_unavailable");
    expect(errorOf(result).message).toContain("Ask the user");
    expect(ran).toEqual([]);
  });

  it("tells the agent the action did not run when the server shuts down while the card waits", async () => {
    const target = open();
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const call = (await mcp(target)).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    await vi.waitFor(() => expect(tab.shown()).toHaveLength(1));
    await target.close();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("confirmation_unavailable");
    expect(errorOf(result).message).toContain("removeNote did not run");
    expect(ran).toEqual([]);
  });

  it("is unavailable when the open app does not render confirmations", async () => {
    const target = open();
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true, "web", false);
    const result = await (
      await mcp(target)
    ).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    expect(errorOf(result).code).toBe("confirmation_unavailable");
    expect(tab.shown()).toEqual([]);
  });

  it("asks even when the ui_ tools are hidden from external agents", async () => {
    const target = open({ external: false });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const client = await mcp(target);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "hello",
      "removeNote",
    ]);
    const call = client.callTool({ name: "removeNote", arguments: { id: "n1" } });
    await settle();
    expect(ran).toEqual([]);
    await tab.approve(tab.shown()[0]!.id);
    expect((await call).isError).toBeFalsy();
    expect(ran).toEqual(["n1"]);
  });

  it("shows the card on every tied client, and the first answer wins", async () => {
    const target = open();
    const a = await openBrowser("tab-a", "/", target);
    const b = await openBrowser("tab-b", "/settings", target);
    await Promise.all([a.presence(true, true), b.presence(true, true)]);
    const call = (await mcp(target)).callTool({
      name: "removeNote",
      arguments: { id: "n1" },
    });
    await settle();
    expect(a.shown()).toHaveLength(1);
    expect(b.shown()).toHaveLength(1);
    const id = a.shown()[0]!.id;
    expect((await a.approve(id)).status).toBe(204);
    expect((await b.approve(id)).status).toBe(404);
    expect((await call).isError).toBeFalsy();
    await settle();
    expect([a.shown(), b.shown()]).toEqual([[], []]);
    expect(ran).toEqual(["n1"]);
  });

  it("does not make the agent wait for the screen while a confirmation is pending", async () => {
    const target = open({ confirmTimeoutMs: 2000 });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const client = await mcp(target);
    const call = client.callTool({ name: "removeNote", arguments: { id: "n1" } });
    await settle();
    const started = Date.now();
    const screenResult = await client.callTool({ name: "ui_screen", arguments: {} });
    expect(screenResult.isError).toBeFalsy();
    expect(Date.now() - started).toBeLessThan(1000);
    await tab.decline(tab.shown()[0]!.id);
    await call;
  });

  it("takes the card away when the caller drops the request while the card waits", async () => {
    const target = open({ confirmTimeoutMs: 5000 });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const controller = new AbortController();
    const call = target
      .fetch(
        new Request("http://app.test/_parlor/actions/removeNote", {
          method: "POST",
          headers: { "content-type": "application/json", "x-parlor-source": "agent" },
          body: JSON.stringify({ id: "n1" }),
          signal: controller.signal,
        }),
      )
      .catch((error: unknown) => error);
    await settle();
    expect(tab.shown()).toHaveLength(1);
    controller.abort();
    await call;
    await settle(100);
    expect(tab.shown()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("takes the card away and never runs the action when the MCP client cancels the call", async () => {
    const target = open({ confirmTimeoutMs: 5000 });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const controller = new AbortController();
    const call = (await mcp(target))
      .callTool(
        { name: "removeNote", arguments: { id: "n1" } },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(tab.shown()).toHaveLength(1));
    const cardId = tab.shown()[0]!.id;
    controller.abort();
    await call;
    await vi.waitFor(() => expect(tab.shown()).toEqual([]));
    expect((await tab.approve(cardId)).status).toBe(404);
    await settle();
    expect(ran).toEqual([]);
  });

  it("leaves another client's call waiting when its own call has the same JSON-RPC id", async () => {
    const target = open({ confirmTimeoutMs: 5000 });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const quitter = await mcp(target, { authorization: "Bearer quitter" });
    const stayer = await mcp(target, { authorization: "Bearer stayer" });
    const controller = new AbortController();
    const cancelled = quitter
      .callTool(
        { name: "removeNote", arguments: { id: "n1" } },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    const waiting = stayer.callTool({ name: "removeNote", arguments: { id: "n2" } });
    await vi.waitFor(() => expect(tab.shown()).toHaveLength(2));
    controller.abort();
    await cancelled;
    await vi.waitFor(() => expect(tab.shown()).toHaveLength(1));
    const remaining = tab.shown()[0]!;
    expect(remaining.input).toEqual({ id: "n2" });
    await tab.approve(remaining.id);
    expect((await waiting).isError).toBeFalsy();
    expect(ran).toEqual(["n2"]);
  });

  it("asks for HTTP callers only when they claim to be an agent, and maps the outcomes to statuses", async () => {
    const target = open({ confirmTimeoutMs: 200 });
    const asUi = await target.fetch(
      new Request("http://app.test/_parlor/actions/removeNote", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-parlor-source": "ui",
          "x-parlor-client": "tab-x",
        },
        body: JSON.stringify({ id: "n1" }),
      }),
    );
    expect(asUi.status).toBe(200);
    const plain = await target.fetch(
      new Request("http://app.test/_parlor/actions/removeNote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "n2" }),
      }),
    );
    expect(plain.status).toBe(200);
    expect(ran).toEqual(["n1", "n2"]);
    const asAgent = (id: string) =>
      target.fetch(
        new Request("http://app.test/_parlor/actions/removeNote", {
          method: "POST",
          headers: { "content-type": "application/json", "x-parlor-source": "agent" },
          body: JSON.stringify({ id }),
        }),
      );
    const none = await asAgent("n3");
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({
      error: { code: "confirmation_unavailable" },
    });
    const tab = await openBrowser("tab-1", "/", target);
    await tab.presence(true, true);
    const unanswered = await asAgent("n4");
    expect(unanswered.status).toBe(504);
    const declining = asAgent("n5");
    await settle();
    await tab.decline(tab.shown()[0]!.id);
    const declined = await declining;
    expect(declined.status).toBe(403);
    expect(await declined.json()).toMatchObject({ error: { code: "declined" } });
    expect(ran).toEqual(["n1", "n2"]);
  });

  it("states the confirmation convention in the server instructions", async () => {
    const target = open();
    expect((await mcp(target)).getInstructions()).toContain("ask the user to approve");
  });
});
