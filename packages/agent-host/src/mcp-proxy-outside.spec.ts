import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpProxy, type McpProxy, type OutsideApp } from "./mcp-proxy.js";
import { hostPaths } from "./paths.js";

const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly tool?: string | undefined;
}

let home: string;
let stub: Server;
let origin: string;
let proxy: McpProxy;
let served: OutsideApp | undefined;
const received: Received[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

const TOOLS = [
  { name: "listCourses", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "createCourse", inputSchema: {}, annotations: { readOnlyHint: false } },
];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "parlor-outside-"));
  stub = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: number | string;
        method: string;
        params?: { name?: string };
      };
      received.push({
        headers: request.headers,
        method: message.method,
        tool: message.params?.name,
      });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              instructions: "These tools belong to Hello.",
            }
          : message.method === "tools/list"
            ? { tools: TOOLS }
            : { content: [{ type: "text", text: `ran ${message.params?.name}` }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  proxy = createMcpProxy("parlor-host");
  proxy.serveOutside((appOrigin) => (appOrigin === origin ? served : undefined));
  await proxy.listen(hostPaths(join(home, ".parlor", "host")).proxy);
});

afterAll(async () => {
  for (const child of children) child.kill();
  await proxy.close();
  stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  received.length = 0;
  served = {
    appOrigin: origin,
    appName: "Hello",
    name: "hello-local",
    account: "alice@example.com",
    token: async (agent) => `token for ${agent}`,
    askHere: vi.fn(async () => true),
  };
});

/** A coding agent outside any turn, speaking MCP to `parlor-host mcp-proxy --app`. */
function agentOutside(appOrigin: string, options: { readonly home?: string } = {}) {
  const child = spawn(process.execPath, [BIN, "mcp-proxy", "--app", appOrigin], {
    env: { PATH: process.env.PATH ?? "", HOME: options.home ?? home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const queue: Record<string, unknown>[] = [];
  const waiting: ((message: Record<string, unknown>) => void)[] = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const next = waiting.shift();
    if (next) next(message);
    else queue.push(message);
  });
  let id = 0;
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const next = () =>
    new Promise<Record<string, unknown>>((resolve) => {
      const message = queue.shift();
      if (message) resolve(message);
      else waiting.push(resolve);
    });
  return {
    send,
    next,
    request: (method: string, params: unknown = {}) => {
      send({ id: ++id, method, params });
      return id;
    },
    initialize: async (elicitation: boolean) => {
      send({
        id: ++id,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: elicitation ? { elicitation: {} } : {},
          clientInfo: { name: "claude-code", version: "1" },
        },
      });
      return next();
    },
  };
}

const textOf = (message: Record<string, unknown>) =>
  (message.result as { content: { text: string }[] }).content[0]!.text;

describe("an agent outside any turn", () => {
  it("is told to use the app only when the user names it, before a browser, and reads with its own token", async () => {
    const agent = agentOutside(origin);
    const initialized = await agent.initialize(true);
    const instructions = (initialized.result as { instructions: string }).instructions;
    expect(instructions).toMatch(
      /^Use these tools only when the user names Hello or "hello-local"/,
    );
    expect(instructions).toContain("as alice@example.com");
    expect(instructions).toContain("use them rather than opening Hello in a browser");
    expect(instructions).toContain('search them for "hello-local" first');
    expect(instructions).toMatch(/These tools belong to Hello\.$/);

    agent.request("tools/call", { name: "listCourses", arguments: {} });
    expect(textOf(await agent.next())).toBe("ran listCourses");
    expect(received.map(({ method, tool }) => [method, tool])).toEqual([
      ["initialize", undefined],
      ["tools/list", undefined],
      ["tools/call", "listCourses"],
    ]);
    expect(new Set(received.map((request) => request.headers.authorization))).toEqual(
      new Set(["Bearer token for Claude Code"]),
    );
  }, 30_000);

  it("asks once, in the agent itself, before the conversation's first change", async () => {
    const agent = agentOutside(origin);
    await agent.initialize(true);
    const first = agent.request("tools/call", { name: "createCourse", arguments: {} });
    const asked = await agent.next();
    expect(asked).toMatchObject({
      method: "elicitation/create",
      params: {
        message:
          "Claude Code wants to change Hello (" +
          origin +
          ") as alice@example.com. Allow changes from this conversation?",
      },
    });
    expect(received.some((request) => request.tool === "createCourse")).toBe(false);
    agent.send({ id: asked.id, result: { action: "accept", content: {} } });
    expect(await agent.next()).toMatchObject({ id: first });
    agent.request("tools/call", { name: "createCourse", arguments: {} });
    expect(textOf(await agent.next())).toBe("ran createCourse");
    expect(received.filter((request) => request.tool === "createCourse")).toHaveLength(2);
    expect(served!.askHere).not.toHaveBeenCalled();
  }, 30_000);

  it("changes nothing when the user declines, and asks again on the next change", async () => {
    const agent = agentOutside(origin);
    await agent.initialize(true);
    agent.request("tools/call", { name: "createCourse", arguments: {} });
    const asked = await agent.next();
    agent.send({ id: asked.id, result: { action: "decline" } });
    const refused = await agent.next();
    expect(refused).toMatchObject({ result: { isError: true } });
    expect(textOf(refused)).toMatch(
      /^Nothing was changed: the user did not allow changes to Hello/,
    );
    agent.request("tools/call", { name: "createCourse", arguments: {} });
    expect(await agent.next()).toMatchObject({ method: "elicitation/create" });
    expect(received.some((request) => request.tool === "createCourse")).toBe(false);
  }, 30_000);

  it("asks on this computer for an agent that cannot ask the user itself", async () => {
    const agent = agentOutside(origin);
    await agent.initialize(false);
    agent.request("tools/call", { name: "createCourse", arguments: {} });
    expect(textOf(await agent.next())).toBe("ran createCourse");
    expect(served!.askHere).toHaveBeenCalledWith(
      `Claude Code wants to change Hello (${origin}) as alice@example.com. Allow changes from this conversation?`,
    );
  }, 30_000);

  it("refuses an app this computer does not let the agents use, saying how to connect it", async () => {
    served = undefined;
    const agent = agentOutside(origin);
    const refused = await agent.initialize(true);
    expect(refused).toMatchObject({ error: { code: -32001 } });
    expect((refused.error as { message: string }).message).toBe(
      `This computer does not let coding agents use ${origin}: it is not connected, or that was turned off. Connect it again with \`npx @parlor/agent-host connect ${origin}\`.`,
    );
    expect(received).toEqual([]);
  }, 30_000);

  it("says Parlor Host is not running when nothing listens", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "parlor-outside-none-"));
    try {
      const agent = agentOutside(origin, { home: elsewhere });
      const refused = await agent.initialize(true);
      expect((refused.error as { message: string }).message).toMatch(
        /^Parlor Host is not running on this computer/,
      );
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);
});
