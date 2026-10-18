import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ActionError, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createServer } from "./create-server.js";
import { originOf, withProgress } from "./mcp.js";

const seen: string[] = [];
const actions = createRegistry({
  hello: defineAction({
    description: "Say hello.",
    input: z.object({ name: z.string().min(1).default("world") }),
    run: ({ name }, ctx) => {
      seen.push(ctx.scope);
      return { message: `Hello, ${name}!`, source: ctx.source };
    },
  }),
  addTask: defineAction({
    description: "Add a task.",
    input: z.object({ title: z.string() }),
    writes: ["tasks"],
    run: ({ title }) => ({ id: "1", title }),
  }),
  removeTask: defineAction({
    description: "Remove a task.",
    input: z.object({ id: z.string() }),
    writes: ["tasks"],
    confirm: true,
    run: ({ id }) => ({ id }),
  }),
  boom: defineAction({
    description: "Always fails.",
    input: z.object({}),
    run: () => {
      throw new Error("secret detail");
    },
  }),
  find: defineAction({
    description: "Find.",
    input: z.object({}),
    run: () => {
      throw new ActionError("not_found", "No such thing");
    },
  }),
});

const server = createServer({
  actions,
  scope: (request) => request.headers.get("x-org") ?? "default",
  agentUi: false,
});

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(headers: Record<string, string> = {}) {
  client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://app.test/_parlor/mcp"),
    {
      fetch: (input, init) =>
        server.fetch(
          new Request(input, { ...init, headers: { ...headersOf(init), ...headers } }),
        ),
    },
  );
  await client.connect(transport);
  return client;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

describe("MCP surface", () => {
  it("lists every action as a tool with its schema and read-only hint", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "addTask",
      "boom",
      "find",
      "hello",
      "removeTask",
    ]);
    const hello = tools.find((t) => t.name === "hello");
    expect(hello?.description).toBe("Say hello.");
    expect(hello?.inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(hello?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "addTask")?.annotations?.readOnlyHint).toBe(
      false,
    );
  });

  it("calls an action with the mcp source and the request's scope", async () => {
    const c = await connect({ "x-org": "acme" });
    const result = await c.callTool({ name: "hello", arguments: { name: "Ada" } });
    expect(result.structuredContent).toEqual({ message: "Hello, Ada!", source: "mcp" });
    expect(seen.at(-1)).toBe("acme");
  });

  it("returns validation problems as tool errors in the same error body, with the issues", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "hello", arguments: { name: "" } });
    expect(result.isError).toBe(true);
    expect(
      JSON.parse(String((result.content as Array<{ text: string }>)[0]?.text)),
    ).toEqual({
      error: {
        code: "invalid_input",
        message: 'Invalid input for "hello"',
        issues: [{ path: "name", message: expect.any(String) }],
      },
    });
  });

  it("renders every failure as the same error body, a code with a message", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(
      JSON.parse(String((result.content as Array<{ text: string }>)[0]?.text)),
    ).toEqual({
      error: { code: "internal", message: "Internal error" },
    });
    const missing = await c.callTool({ name: "find", arguments: {} });
    expect(
      JSON.parse(String((missing.content as Array<{ text: string }>)[0]?.text)),
    ).toEqual({
      error: { code: "not_found", message: "No such thing" },
    });
  });

  it("adds the confirmation note to a confirm action's description and leaves the others alone", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === "removeTask")?.description).toBe(
      "Remove a task. When an agent calls it, the user must approve it in the app first; the call waits for that answer and fails with declined, confirmation_timeout or confirmation_unavailable without running.",
    );
    expect(tools.find((t) => t.name === "hello")?.description).toBe("Say hello.");
    expect(tools.find((t) => t.name === "addTask")?.description).toBe("Add a task.");
  });

  it("refuses a confirm action when agent UI is off, since nobody can be asked", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "removeTask", arguments: { id: "1" } });
    expect(result.isError).toBe(true);
    expect(
      JSON.parse(String((result.content as Array<{ text: string }>)[0]?.text)),
    ).toMatchObject({
      error: { code: "confirmation_unavailable" },
    });
  });

  it("can be disabled", async () => {
    const plain = createServer({ actions, mcp: false });
    const response = await plain.fetch(
      new Request("http://app.test/_parlor/mcp", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(404);
  });
});

describe("MCP progress while a call waits", () => {
  const ctxWith = (
    progressToken: string | undefined,
    notify = vi.fn(async () => {}),
  ) => ({
    mcpReq: {
      _meta: progressToken === undefined ? undefined : { progressToken },
      notify,
    },
  });

  it("notifies progress every interval while the work runs, and stops when it ends", async () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn(async () => {});
      let finish!: () => void;
      const work = new Promise<string>((resolve) => (finish = () => resolve("done")));
      const result = withProgress(ctxWith("tok", notify) as never, () => work, 10_000);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(notify.mock.calls.map(([n]) => n)).toEqual([
        {
          method: "notifications/progress",
          params: { progressToken: "tok", progress: 1, message: expect.any(String) },
        },
        {
          method: "notifications/progress",
          params: { progressToken: "tok", progress: 2, message: expect.any(String) },
        },
      ]);
      finish();
      await expect(result).resolves.toBe("done");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when the request carried no progress token, and survives a failing notify", async () => {
    vi.useFakeTimers();
    try {
      const quiet = vi.fn(async () => {});
      const a = withProgress(ctxWith(undefined, quiet) as never, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        return 1;
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(a).resolves.toBe(1);
      expect(quiet).not.toHaveBeenCalled();
      const failing = vi.fn(async () => {
        throw new Error("closed");
      });
      const b = withProgress(ctxWith("tok", failing) as never, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        return 2;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(b).resolves.toBe(2);
      expect(failing).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the agent named on a confirmation", () => {
  it("uses the client name the per-request envelope carries", () => {
    const ctx = {
      mcpReq: {
        envelope: {
          "io.modelcontextprotocol/clientInfo": { name: "Claude Code", version: "2" },
        },
      },
    };
    expect(originOf(ctx as never)).toEqual({ via: "mcp", name: "Claude Code" });
  });

  it("is the origin alone when the transport carries no client info, and names the client when it does", () => {
    expect(
      originOf({
        mcpReq: {
          envelope: { "io.modelcontextprotocol/clientInfo": { name: "Claude Code" } },
        },
      } as never),
    ).toEqual({ via: "mcp", name: "Claude Code" });
    expect(originOf({ mcpReq: {} } as never)).toEqual({ via: "mcp" });
    expect(
      originOf({
        mcpReq: { envelope: { "io.modelcontextprotocol/clientInfo": {} } },
      } as never),
    ).toEqual({
      via: "mcp",
    });
  });
});
