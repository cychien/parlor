import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createServer } from "./create-server.js";

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
});

const server = createServer({
  actions,
  scope: (request) => request.headers.get("x-org") ?? "default",
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
    expect(tools.map((t) => t.name).sort()).toEqual(["addTask", "hello"]);
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

  it("returns validation problems as tool errors instead of protocol errors", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "hello", arguments: { name: "" } });
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text: string }>)[0]?.text)).toMatch(/name:/);
  });

  it("can be disabled", async () => {
    const plain = createServer({ actions, mcp: false });
    const response = await plain.fetch(
      new Request("http://app.test/_parlor/mcp", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(404);
  });
});
