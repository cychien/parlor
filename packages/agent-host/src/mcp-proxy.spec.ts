import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createMcpProxy,
  DISCONNECTED_MESSAGE,
  type McpProxy,
  NO_TURN_MESSAGE,
} from "./mcp-proxy.js";

const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const HELD = "ui_wait_forever";

const APP_ANSWER =
  '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"navigated"}]}}';

let dir: string;
let stub: Server;
let origin: string;
let proxy: McpProxy;
const received: Received[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-proxy-"));
  stub = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      const { id, params } = JSON.parse(body) as {
        id?: number;
        params?: { name?: string };
      };
      if (params?.name === HELD) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(APP_ANSWER.replace('"id":7', `"id":${id}`));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  proxy = createMcpProxy("parlor-host");
  await proxy.listen(join(dir, "run", "proxy.sock"));
});

afterAll(async () => {
  for (const child of children) child.kill();
  await proxy.close();
  stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function agentSide(env: Readonly<Record<string, string>>) {
  const child = spawn(process.execPath, [BIN, "mcp-proxy"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines: Interface = createInterface({ input: child.stdout });
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  lines.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else queue.push(line);
  });
  return {
    child,
    send: (line: string) => child.stdin.write(`${line}\n`),
    next: () =>
      new Promise<string>((resolve) => {
        const line = queue.shift();
        if (line !== undefined) resolve(line);
        else waiting.push(resolve);
      }),
  };
}

const call = (id: number, name = "ui_navigate") =>
  `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${name}","arguments":{"to":"/settings"}}}`;

describe("the MCP proxy", () => {
  it("C3: forwards each call byte for byte with the current turn token and nothing else", async () => {
    const session = proxy.open("hello", origin);
    expect(session.server).toEqual({
      name: "hello",
      command: "parlor-host",
      args: ["mcp-proxy"],
      env: {
        PARLOR_HOST_PROXY_SOCKET: join(dir, "run", "proxy.sock"),
        PARLOR_HOST_PROXY_NONCE: session.nonce,
      },
    });
    const agent = agentSide(session.server.env);
    session.begin({ token: "tokenA", expiresAt: Date.now() + 60_000 });
    agent.send(call(7));
    expect(await agent.next()).toBe(APP_ANSWER);

    session.renew({ token: "tokenB", expiresAt: Date.now() + 60_000 });
    agent.send(call(8));
    expect(await agent.next()).toBe(APP_ANSWER.replace('"id":7', '"id":8'));

    expect(received.map((request) => request.body)).toEqual([call(7), call(8)]);
    expect(received.map((request) => request.headers.authorization)).toEqual([
      "Bearer tokenA",
      "Bearer tokenB",
    ]);
    for (const { headers } of received) {
      expect(headers).not.toHaveProperty("x-parlor-client");
      expect(headers).not.toHaveProperty("x-parlor-source");
      expect(headers["content-type"]).toBe("application/json");
    }
    session.dispose();
  });

  it("answers a call between turns with NO_TURN_MESSAGE and never reaches the app", async () => {
    received.length = 0;
    const session = proxy.open("hello", origin);
    const agent = agentSide(session.server.env);
    agent.send(call(1));
    expect(JSON.parse(await agent.next())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: NO_TURN_MESSAGE }], isError: true },
    });
    session.begin({ token: "tokenA", expiresAt: Date.now() + 60_000 });
    session.end();
    agent.send(call(2));
    expect(JSON.parse(await agent.next())).toMatchObject({
      id: 2,
      result: { content: [{ text: NO_TURN_MESSAGE }], isError: true },
    });
    expect(received).toEqual([]);
    session.dispose();
  });

  it("only lets the owner reach its 0600 socket, and only with a nonce it handed out", async () => {
    received.length = 0;
    const session = proxy.open("hello", origin);
    session.begin({ token: "tokenA", expiresAt: Date.now() + 60_000 });
    expect((await stat(join(dir, "run", "proxy.sock"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "run"))).mode & 0o777).toBe(0o700);
    const stranger = agentSide({
      PARLOR_HOST_PROXY_SOCKET: join(dir, "run", "proxy.sock"),
      PARLOR_HOST_PROXY_NONCE: "guessed",
    });
    stranger.send(call(3));
    expect(JSON.parse(await stranger.next())).toMatchObject({
      id: 3,
      error: { code: -32001, message: DISCONNECTED_MESSAGE },
    });
    expect(received).toEqual([]);
    stranger.child.stdin.end();
    const closed = await new Promise<number | null>((resolve) =>
      stranger.child.once("exit", resolve),
    );
    expect(closed).toBe(0);

    const orphan = agentSide({
      PARLOR_HOST_PROXY_SOCKET: join(dir, "run", "absent.sock"),
      PARLOR_HOST_PROXY_NONCE: session.nonce,
    });
    orphan.send(call(4));
    expect(JSON.parse(await orphan.next())).toMatchObject({
      id: 4,
      error: { code: -32001, message: DISCONNECTED_MESSAGE },
    });
    session.dispose();
  });

  it("answers every call once its session is gone: in flight at that moment, and after it", async () => {
    const session = proxy.open("hello", origin);
    const agent = agentSide(session.server.env);
    session.begin({ token: "tokenA", expiresAt: Date.now() + 60_000 });
    agent.send(call(1));
    expect(JSON.parse(await agent.next())).toMatchObject({ id: 1, result: {} });

    agent.send(call(2, HELD));
    await vi.waitFor(() => expect(received.at(-1)?.body).toBe(call(2, HELD)));
    session.dispose();
    expect(JSON.parse(await agent.next())).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32001, message: DISCONNECTED_MESSAGE },
    });

    const sentAt = Date.now();
    agent.send(call(3));
    expect(JSON.parse(await agent.next())).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32001, message: DISCONNECTED_MESSAGE },
    });
    expect(Date.now() - sentAt).toBeLessThan(1_000);
    expect(agent.child.exitCode).toBeNull();
  });
});
