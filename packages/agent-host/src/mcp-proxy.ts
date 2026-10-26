import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { Delegation } from "@parlor/server";

import type { StdioMcpServer } from "./acp.js";
import { onLines } from "./lines.js";
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
  /**
   * Serves `parlor-host mcp-proxy --app <origin>`: a coding agent on this computer outside
   * any turn, such as Claude Code in a terminal. `undefined` refuses the app.
   */
  serveOutside(resolve: (appOrigin: string) => OutsideApp | undefined): void;
  stopListening(): Promise<void>;
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

/** An app a coding agent on this computer may use outside its sidebar. */
export interface OutsideApp {
  readonly appOrigin: string;
  readonly appName: string;
  /** The name the user asks the agent with, its MCP server name. */
  readonly name: string;
  /** Whose account the agent acts as: its email, or its name. */
  readonly account: string;
  /** A token for `agent`'s calls, fresh enough to use now. */
  token(agent: string): Promise<string>;
  /** Asks on this computer, for an agent that cannot ask the user itself. */
  askHere(question: string): Promise<boolean>;
}

export const NO_TURN_MESSAGE =
  "No turn is active: the user has not asked anything right now. Wait for their next message.";

export const DISCONNECTED_MESSAGE =
  "This computer no longer serves the app: it was disconnected, or Parlor Host stopped.";

const OUTSIDE_PREFIX = "app ";
const AGENT_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  "codex-mcp-client": "Codex",
  codex: "Codex",
};

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

/** An app's answer to one handshake request, without its id. */
type KnownAnswer = { readonly result: unknown } | { readonly error: unknown };

interface Live {
  readonly appOrigin: string;
  /** The app's answers to the handshake every session repeats; undefined outside turns' sessions. */
  readonly known: Map<string, KnownAnswer> | undefined;
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

/**
 * What a new session asks before its first prompt, answered by the app the same way each
 * time for the same parameters. A session gets the last answer at once while the app is
 * asked again behind it; a list that changed is announced to the agent.
 */
const HANDSHAKE: ReadonlySet<string> = new Set([
  "server/discover",
  "initialize",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);
const LIST_CHANGED: Readonly<Record<string, string>> = {
  "tools/list": "notifications/tools/list_changed",
  "resources/list": "notifications/resources/list_changed",
  "prompts/list": "notifications/prompts/list_changed",
};
/** Statuses the same request gets again: never a credential, rate or server failure. */
const STABLE_REFUSALS: ReadonlySet<number> = new Set([400, 404, 405]);

const handshakeKey = (message: Message) =>
  typeof message.method === "string" && HANDSHAKE.has(message.method)
    ? `${message.method} ${JSON.stringify((message as { readonly params?: unknown }).params ?? null)}`
    : undefined;

function knownAnswer(answer: Message | undefined): KnownAnswer | undefined {
  if (answer === undefined) return undefined;
  if (answer.result !== undefined) return { result: answer.result };
  const { error } = answer as { readonly error?: unknown };
  return error === undefined ? undefined : { error };
}

/** What the session learns from an `initialize` or `tools/list` answer, wherever it came from. */
function learn(live: Live, method: string, answer: KnownAnswer): void {
  if (!("result" in answer)) return;
  if (method === "initialize") {
    live.initialized = answer.result;
    const version = (answer.result as { readonly protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    if (typeof version === "string") live.protocolVersion = version;
  }
  if (method === "tools/list") live.tools = answer.result;
}

/** One line per message on the agent's stdio: only a body with a raw newline is compacted. */
const asLine = (text: string) =>
  text.includes("\n") ? JSON.stringify(JSON.parse(text)) : text;

function betweenTurns(live: Live, message: Message): string | undefined {
  if (message.id === undefined || typeof message.method !== "string") return undefined;
  const { id } = message;
  const key = handshakeKey(message);
  const known = key === undefined ? undefined : live.known?.get(key);
  if (known) {
    learn(live, message.method, known);
    return JSON.stringify({ jsonrpc: "2.0", id, ...known });
  }
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

/** Sends one message to the app; resolves with its status and what the request was answered. */
async function forward(
  live: Live,
  token: string,
  line: string,
  message: Message,
  reply: (line: string) => void,
): Promise<{ readonly status: number; readonly answer: Message | undefined }> {
  const method = typeof message.method === "string" ? message.method : "response";
  const controller = new AbortController();
  live.inflight.add(controller);
  let status = 0;
  let given: Message | undefined;
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
        given = answer;
        const known = knownAnswer(answer);
        if (known) learn(live, method, known);
      }
      reply(asLine(text));
    }
    if (message.id !== undefined && !answered) {
      const refused = failure(message.id, REFUSED_CODE, refusal(status));
      given = parse(refused);
      reply(refused);
    }
  } catch (error) {
    status = 0;
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
  return { status, answer: given };
}

/** Keeps the app's answer to a handshake request when the same request gets it again. */
function remember(
  live: Live,
  key: string,
  outcome: { readonly status: number; readonly answer: Message | undefined },
): KnownAnswer | undefined {
  const { status } = outcome;
  const stable = (status >= 200 && status < 300) || STABLE_REFUSALS.has(status);
  const known = stable ? knownAnswer(outcome.answer) : undefined;
  // A refused initialize would leave every later session without the app's tools.
  if (!known || (key.startsWith("initialize ") && !("result" in known))) return undefined;
  live.known?.set(key, known);
  return known;
}

/** Answers a handshake request from what the app said last, then asks the app again. */
function replay(
  live: Live,
  token: string,
  line: string,
  message: Message,
  key: string,
  known: KnownAnswer,
  reply: (line: string) => void,
): void {
  const method = message.method as string;
  learn(live, method, known);
  reply(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...known }));
  void forward(live, token, line, message, () => undefined).then((outcome) => {
    const fresh = remember(live, key, outcome);
    const changed = LIST_CHANGED[method];
    if (!changed || !fresh || JSON.stringify(fresh) === JSON.stringify(known)) return;
    const notice = JSON.stringify({ jsonrpc: "2.0", method: changed });
    for (const socket of live.sockets) if (!socket.destroyed) socket.write(`${notice}\n`);
  });
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
  const key = message.id === undefined ? undefined : handshakeKey(message);
  if (key === undefined) {
    void forward(live, token, line, message, reply);
    return;
  }
  const known = live.known?.get(key);
  if (known) {
    replay(live, token, line, message, key, known, reply);
    return;
  }
  void forward(live, token, line, message, reply).then((outcome) =>
    remember(live, key, outcome),
  );
}

/**
 * One agent outside a turn, on one socket. Reads run as asked; the first change in the
 * conversation waits for the user, through the agent's own elicitation where it has it.
 */
function outsideSession(
  app: OutsideApp,
  socket: Socket,
  reply: (line: string) => void,
): (line: string) => void {
  const live: Live = {
    appOrigin: app.appOrigin.replace(/\/+$/, ""),
    known: undefined,
    token: undefined,
    protocolVersion: undefined,
    initialized: undefined,
    tools: undefined,
    inflight: new Set(),
    sockets: new Set([socket]),
  };
  let agent = "A coding agent";
  let elicits = false;
  let changesAllowed: Promise<boolean> | undefined;
  let asked = 0;
  const answers = new Map<string, (allowed: boolean) => void>();

  const send = async (line: string, message: Message, onReply = reply) => {
    let token: string;
    try {
      token = await app.token(agent);
    } catch (error) {
      if (message.id !== undefined) {
        onReply(
          failure(message.id, REFUSED_CODE, `${app.appName} refused: ${String(error)}`),
        );
      }
      return;
    }
    await forward(live, token, line, message, onReply);
  };

  const readOnly = async (tool: string): Promise<boolean> => {
    if (live.tools === undefined) {
      const id = `parlor-tools-${++asked}`;
      const list = { jsonrpc: "2.0", id, method: "tools/list", params: {} };
      await send(JSON.stringify(list), list, () => undefined);
    }
    const tools = (live.tools as { readonly tools?: readonly ToolEntry[] } | undefined)
      ?.tools;
    return (
      tools?.find((entry) => entry.name === tool)?.annotations?.readOnlyHint === true
    );
  };

  const askToChange = (): Promise<boolean> => {
    const question = `${agent} wants to change ${app.appName} (${app.appOrigin}) as ${app.account}. Allow changes from this conversation?`;
    if (!elicits) return app.askHere(question);
    const id = `parlor-allow-${++asked}`;
    const answered = new Promise<boolean>((resolve) => answers.set(id, resolve));
    reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "elicitation/create",
        params: {
          message: question,
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    );
    return answered;
  };

  return (line) => {
    const message = parse(line);
    if (!message) return;
    if (message.method === undefined && typeof message.id === "string") {
      const answer = answers.get(message.id);
      if (answer) {
        answers.delete(message.id);
        const action = (message.result as { readonly action?: unknown } | undefined)
          ?.action;
        answer(action === "accept");
        return;
      }
    }
    if (message.method === "initialize") {
      const params = (message as { readonly params?: InitializeParams }).params;
      const client = params?.clientInfo?.name;
      if (typeof client === "string" && client !== "")
        agent = AGENT_NAMES[client] ?? client;
      elicits = params?.capabilities?.elicitation !== undefined;
      logEvent("outside_agent", { appOrigin: app.appOrigin, agent, elicits });
      void send(line, message, (answer) => reply(withGuidance(answer, app, agent)));
      return;
    }
    if (message.method === "tools/call" && message.id !== undefined) {
      const tool = (message as { readonly params?: { readonly name?: unknown } }).params
        ?.name;
      void (async () => {
        if (typeof tool === "string" && !(await readOnly(tool))) {
          changesAllowed ??= askToChange().then((allowed) => {
            if (!allowed) changesAllowed = undefined;
            return allowed;
          });
          if (!(await changesAllowed)) {
            reply(
              result(message.id!, {
                content: [
                  {
                    type: "text",
                    text: `Nothing was changed: the user did not allow changes to ${app.appName} from this conversation, or could not be asked here. Tell them so. If they ask for the change again, they are asked again first; nothing in ${app.appName} itself turns this on.`,
                  },
                ],
                isError: true,
              }),
            );
            return;
          }
        }
        await send(line, message);
      })();
      return;
    }
    void send(line, message);
  };
}

interface ToolEntry {
  readonly name?: string;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

interface InitializeParams {
  readonly clientInfo?: { readonly name?: unknown };
  readonly capabilities?: { readonly elicitation?: unknown };
}

/** The app's own instructions, led by when to use it at all: only when the user names it. */
function withGuidance(line: string, app: OutsideApp, agent: string): string {
  const answer = parse(line);
  const initialized = answer?.result as { readonly instructions?: unknown } | undefined;
  if (!initialized || typeof initialized !== "object") return line;
  const guidance = `Use these tools only when the user names ${app.appName} or "${app.name}" in their request: they act on the live app at ${app.appOrigin} as ${app.account}, and ${agent} runs outside the app here. Reading is free; before the first change in this conversation the user is asked to allow changes.`;
  const own =
    typeof initialized.instructions === "string" ? initialized.instructions : "";
  return JSON.stringify({
    ...answer,
    result: { ...initialized, instructions: own ? `${guidance}\n\n${own}` : guidance },
  });
}

export function createMcpProxy(hostBinary: string): McpProxy {
  const sessions = new Map<string, Live>();
  const handshakes = new Map<string, Map<string, KnownAnswer>>();
  let server: Server | undefined;
  let socketPath: string | undefined;
  let outside: (appOrigin: string) => OutsideApp | undefined = () => undefined;

  const accept = (socket: Socket) => {
    let live: Live | undefined;
    let outsideLine: ((line: string) => void) | undefined;
    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\n`);
    };
    onLines(socket, (line) => {
      if (outsideLine !== undefined) {
        outsideLine(line);
        return;
      }
      if (live !== undefined) {
        handle(live, line, reply);
        return;
      }
      const first = line.trim();
      if (first.startsWith(OUTSIDE_PREFIX)) {
        const appOrigin = first.slice(OUTSIDE_PREFIX.length);
        const app = outside(appOrigin);
        if (!app) {
          reply(JSON.stringify({ refused: notServedMessage(appOrigin) }));
          socket.end();
          return;
        }
        outsideLine = outsideSession(app, socket, reply);
        return;
      }
      live = sessions.get(first);
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
    serveOutside(resolve) {
      outside = resolve;
    },
    open(appServer, appOrigin) {
      if (socketPath === undefined)
        throw new Error("The MCP proxy is not listening yet.");
      const nonce = randomBytes(24).toString("base64url");
      const origin = appOrigin.replace(/\/+$/, "");
      let known = handshakes.get(origin);
      if (!known) {
        known = new Map();
        handshakes.set(origin, known);
      }
      const live: Live = {
        appOrigin: origin,
        known,
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
    async stopListening() {
      const closing = server;
      server = undefined;
      if (!closing) return;
      closing.close();
      if (socketPath) await rm(socketPath, { force: true });
    },
    async close() {
      for (const live of sessions.values()) {
        for (const controller of live.inflight) controller.abort();
        for (const socket of live.sockets) socket.destroy();
      }
      sessions.clear();
      const closing = server;
      server = undefined;
      if (closing) {
        await new Promise<void>((resolve) => closing.close(() => resolve()));
        if (socketPath) await rm(socketPath, { force: true });
      }
    },
  };
}

/** Why an agent outside a turn cannot use `appOrigin` here. */
function notServedMessage(appOrigin: string): string {
  return `This computer does not let coding agents use ${appOrigin}: it is not connected, or that was turned off. Connect it again with \`npx @parlor/agent-host connect ${appOrigin}\`.`;
}

const notRunningMessage = (appOrigin: string) =>
  `Parlor Host is not running on this computer, so ${appOrigin} cannot be reached. Open the app's agent sidebar, or run \`npx @parlor/agent-host connect ${appOrigin}\`.`;

/**
 * `parlor-host mcp-proxy`: stdio to the daemon socket and back. Inside a turn the
 * environment names the session; `--app` serves an agent outside any turn. Once the daemon
 * hangs up, every request still unanswered, and every later one, is answered with an error
 * here.
 */
export async function runMcpProxyProcess(
  env: NodeJS.ProcessEnv,
  outside?: { readonly appOrigin: string; readonly socketPath: string },
): Promise<void> {
  const path = outside?.socketPath ?? env[SOCKET_ENV];
  const nonce = env[NONCE_ENV];
  if (!path || (!outside && !nonce)) {
    throw new Error(`${SOCKET_ENV} and ${NONCE_ENV} must be set, or --app.`);
  }
  let why = outside ? notRunningMessage(outside.appOrigin) : DISCONNECTED_MESSAGE;
  const unanswered = new Set<JsonRpcId>();
  const toAgent = (line: string) => void process.stdout.write(`${line}\n`);
  const refuse = (id: JsonRpcId) => toAgent(failure(id, REFUSED_CODE, why));
  process.stdout.on("error", () => undefined);

  const daemon = connect(path);
  daemon.on("error", () => daemon.destroy());
  daemon.once("connect", () => {
    if (outside) why = DISCONNECTED_MESSAGE;
  });
  const hungUp = new Promise<void>((resolve) =>
    daemon.once("close", () => {
      for (const id of unanswered) refuse(id);
      unanswered.clear();
      resolve();
    }),
  );
  daemon.write(outside ? `${OUTSIDE_PREFIX}${outside.appOrigin}\n` : `${nonce}\n`);
  onLines(daemon, (line) => {
    const refused = (parse(line) as { readonly refused?: unknown } | undefined)?.refused;
    if (typeof refused === "string") {
      why = refused;
      return;
    }
    const message = parse(line);
    if (message?.id !== undefined && message.method === undefined) {
      unanswered.delete(message.id);
    }
    toAgent(line);
  });

  const agent = onLines(process.stdin, (line) => {
    const message = parse(line);
    const id = typeof message?.method === "string" ? message.id : undefined;
    if (!daemon.destroyed) {
      if (id !== undefined) unanswered.add(id);
      daemon.write(`${line}\n`);
    } else if (id !== undefined) {
      refuse(id);
    }
  });
  await once(agent, "close");
  daemon.end();
  await hungUp;
}
