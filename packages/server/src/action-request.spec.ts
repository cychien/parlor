import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createServer } from "./create-server.js";

const actions = createRegistry({
  pass: defineAction({
    description: "Read the visitor's pass from the request that made the call.",
    input: z.object({}),
    run: (_input, ctx) => ({
      cookie: ctx.request?.headers.get("cookie") ?? null,
      path: ctx.request ? new URL(ctx.request.url).pathname : null,
    }),
  }),
});

const server = createServer({ actions, agentUi: false });

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("the request an action sees", () => {
  it("is the HTTP request of a call over HTTP", async () => {
    const response = await server.fetch(
      new Request("http://app.test/_parlor/actions/pass", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "pass=open" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { cookie: "pass=open", path: "/_parlor/actions/pass" },
    });
  });

  it("is the MCP request of a call over MCP", async () => {
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://app.test/_parlor/mcp"), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("cookie", "pass=agent");
          return server.fetch(new Request(input, { ...init, headers }));
        },
      }),
    );
    const result = await client.callTool({ name: "pass", arguments: {} });
    expect(result.structuredContent ?? JSON.parse(textOf(result))).toMatchObject({
      cookie: "pass=agent",
      path: "/_parlor/mcp",
    });
  });
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text?: string }[];
  return first?.text ?? "null";
}
