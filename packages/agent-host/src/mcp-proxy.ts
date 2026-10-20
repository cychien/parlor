import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type { Delegation } from "@parlor/server";

import type { StdioMcpServer } from "./acp.js";
import { logEvent } from "./log.js";

/**
 * The agent's MCP server for an app is this host: a stdio server (`parlor-host
 * mcp-proxy`) that connects back to the daemon's 0600 socket and names its session by a
 * nonce. The daemon forwards each message to `<app>/_parlor/mcp` with the current turn's
 * token, so no app credential is ever in the agent's config, logs or environment.
 */
export interface McpProxy {
  listen(socketPath: string): Promise<void>;
  open(appServer: string, appOrigin: string): ProxySession;
  close(): Promise<void>;
}

export interface ProxySession {
  readonly nonce: string;
  /** The entry for `session/new`. */
  readonly server: StdioMcpServer;
  /** Forward with this token until `end`; a `tools/call` outside a turn gets NO_TURN_MESSAGE. */
  begin(token: Delegation): void;
  renew(token: Delegation): void;
  end(): void;
  dispose(): void;
}

export const NO_TURN_MESSAGE =
  "No turn is active: the user has not asked anything right now. Wait for their next message.";

const SOCKET_ENV = "PARLOR_HOST_PROXY_SOCKET";
const NONCE_ENV = "PARLOR_HOST_PROXY_NONCE";
const NO_TURN_CODE = -32000;
const REFUSED_CODE = -32001;

type JsonRpcId = string | number | null;

interface Message {
  readonly jsonrpc?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly result?: unknown;
}

interface Live {
  readonly appOrigin: string;
  token: string | undefined;
  protocolVersion: string | undefined;
  initialized: unknown;
  tools: unknown;
  readonly inflight: Set<AbortController>;
  readonly sockets: Set<Socket>;
}

function parse(text: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Message)
      : undefined;
  } catch {
    return undefined;
  }
}

const result = (id: JsonRpcId, value: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: value });

const failure = (id: JsonRpcId, code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

/** One line per message on the agent's stdio: only a body with a raw newline is compacted. */
const asLine = (text: string) =>
  text.includes("\n") ? JSON.stringify(JSON.parse(text)) : text;

function betweenTurns(live: Live, message: Message): string | undefined {
  if (message.id === undefined || typeof message.method !== "string") return undefined;
  const { id } = message;
  switch (message.method) {
    case "ping":
      return result(id, {});
    case "initialize":
      return live.initialized === undefined
        ? failure(id, NO_TURN_CODE, NO_TURN_MESSAGE)
        : result(id, live.initialized);
    case "tools/list":
      return live.tools === undefined
        ? failure(id, NO_TURN_CODE, NO_TURN_MESSAGE)
        : result(id, live.tools);
    case "tools/call":
      return result(id, {
        content: [{ type: "text", text: NO_TURN_MESSAGE }],
        isError: true,
      });
    default:
      return failure(id, NO_TURN_CODE, NO_TURN_MESSAGE);
  }
}

async function* serverSentData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length > 0) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
      end = buffer.indexOf("\n");
    }
  }
  if (data.length > 0) yield data.join("\n");
}

function refusal(status: number): string {
  return status === 401
    ? "This computer can no longer act for the app: the turn ended or the computer was disconnected."
    : `The app answered HTTP ${status}.`;
}

async function forward(
  live: Live,
  token: string,
  line: string,
  message: Message,
  reply: (line: string) => void,
): Promise<void> {
  const method = typeof message.method === "string" ? message.method : "response";
  const controller = new AbortController();
  live.inflight.add(controller);
  let status = 0;
  try {
    const response = await fetch(`${live.appOrigin}/_parlor/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(live.protocolVersion ? { "mcp-protocol-version": live.protocolVersion } : {}),
      },
      body: line,
      signal: controller.signal,
    });
    status = response.status;
    const bodies: string[] = [];
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      if (response.body)
        for await (const data of serverSentData(response.body)) bodies.push(data);
    } else {
      const text = await response.text();
      if (text.trim() !== "") bodies.push(text);
    }
    let answered = false;
    for (const text of bodies) {
      const answer = parse(text);
      if (answer?.jsonrpc !== "2.0") continue;
      if (answer.id === message.id) {
        answered = true;
        if (method === "initialize" && answer.result !== undefined) {
          live.initialized = answer.result;
          const version = (answer.result as { readonly protocolVersion?: unknown })
            .protocolVersion;
          if (typeof version === "string") live.protocolVersion = version;
        }
        if (method === "tools/list" && answer.result !== undefined)
          live.tools = answer.result;
      }
      reply(asLine(text));
    }
    if (message.id !== undefined && !answered) {
      reply(failure(message.id, REFUSED_CODE, refusal(status)));
    }
  } catch (error) {
    if (message.id !== undefined) {
      reply(
        controller.signal.aborted
          ? failure(message.id, NO_TURN_CODE, NO_TURN_MESSAGE)
          : failure(
              message.id,
              REFUSED_CODE,
              `The app could not be reached: ${String(error)}`,
            ),
      );
    }
  } finally {
    live.inflight.delete(controller);
    logEvent("proxy_forward", { appOrigin: live.appOrigin, rpcMethod: method, status });
  }
}

function handle(live: Live, line: string, reply: (line: string) => void): void {
  const message = parse(line);
  if (!message) return;
  const token = live.token;
  if (token === undefined) {
    const answer = betweenTurns(live, message);
    if (answer) reply(answer);
    return;
  }
  if (
    message.method === "tools/list" &&
    live.tools !== undefined &&
    message.id !== undefined
  ) {
    reply(result(message.id, live.tools));
    return;
  }
  void forward(live, token, line, message, reply);
}

export function createMcpProxy(hostBinary: string): McpProxy {
  const sessions = new Map<string, Live>();
  let server: Server | undefined;
  let socketPath: string | undefined;

  const accept = (socket: Socket) => {
    let live: Live | undefined;
    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\n`);
    };
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      if (live !== undefined) {
        handle(live, line, reply);
        return;
      }
      live = sessions.get(line.trim());
      if (live) live.sockets.add(socket);
      else socket.destroy();
    });
    socket.on("close", () => live?.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  return {
    async listen(path) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await rm(path, { force: true });
      const listening = createServer(accept);
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(path, () => resolve());
      });
      await chmod(path, 0o600);
      server = listening;
      socketPath = path;
    },
    open(appServer, appOrigin) {
      if (socketPath === undefined)
        throw new Error("The MCP proxy is not listening yet.");
      const nonce = randomBytes(24).toString("base64url");
      const live: Live = {
        appOrigin: appOrigin.replace(/\/+$/, ""),
        token: undefined,
        protocolVersion: undefined,
        initialized: undefined,
        tools: undefined,
        inflight: new Set(),
        sockets: new Set(),
      };
      sessions.set(nonce, live);
      const end = () => {
        live.token = undefined;
        for (const controller of live.inflight) controller.abort();
      };
      return {
        nonce,
        server: {
          name: appServer,
          command: hostBinary,
          args: ["mcp-proxy"],
          env: { [SOCKET_ENV]: socketPath, [NONCE_ENV]: nonce },
        },
        begin: (token) => {
          live.token = token.token;
        },
        renew: (token) => {
          if (live.token !== undefined) live.token = token.token;
        },
        end,
        dispose: () => {
          end();
          sessions.delete(nonce);
          for (const socket of live.sockets) socket.destroy();
        },
      };
    },
    async close() {
      for (const live of sessions.values()) {
        for (const controller of live.inflight) controller.abort();
        for (const socket of live.sockets) socket.destroy();
      }
      sessions.clear();
      const closing = server;
      server = undefined;
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
      if (socketPath) await rm(socketPath, { force: true });
    },
  };
}

/** `parlor-host mcp-proxy`: stdio to the daemon socket and back, nothing else. */
export async function runMcpProxyProcess(env: NodeJS.ProcessEnv): Promise<void> {
  const path = env[SOCKET_ENV];
  const nonce = env[NONCE_ENV];
  if (!path || !nonce) throw new Error(`${SOCKET_ENV} and ${NONCE_ENV} must be set.`);
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`${nonce}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    process.stdin.once("end", () => socket.end());
  });
  process.stdin.unpipe(socket);
  process.stdin.destroy();
}
