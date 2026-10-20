import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  agent as acpAgent,
  client as acpClient,
  type ClientContext,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type McpServer,
  type McpServerStdio,
  type PromptRequest,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type StopReason as AcpStopReason,
  type Stream,
  type ToolCall,
  type ToolCallUpdate,
  type ToolKind as AcpToolKind,
} from "@agentclientprotocol/sdk";

import type { AgentProfile } from "./agents.js";
import { logEvent } from "./log.js";

/**
 * The only file that knows ACP. The v1 adapter speaks ndjson over stdio through
 * `@agentclientprotocol/sdk`; an ACP v2 or HTTP-transport agent implements the same
 * port. No ACP type crosses this file.
 */
export interface AgentLauncher {
  /** Spawns the profile (never through a shell), runs `initialize`, reports problems. */
  launch(profile: AgentProfile, options: LaunchOptions): Promise<AgentConnection>;
}

export interface LaunchOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface AgentConnection {
  readonly capabilities: AgentCapabilities;
  openSession(input: OpenSessionInput): Promise<AgentSession>;
  readonly exited: Promise<AgentExit>;
  /** Kills the whole process group. */
  kill(): Promise<void>;
}

/** `openSession` would not run the session; `leftOpen` when the agent still holds it. */
export class SessionRefused extends Error {
  override readonly name = "SessionRefused";
  constructor(
    message: string,
    readonly leftOpen: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AgentCapabilities {
  readonly resume: boolean;
  readonly close: boolean;
  readonly mcpHttp: boolean;
  /** False until the user logs the agent in on a terminal; `problem` says how. */
  readonly ready: boolean;
  readonly problem?: string | undefined;
}

export interface OpenSessionInput {
  readonly cwd: string;
  readonly mcpServers: readonly StdioMcpServer[];
  readonly resume?: string | undefined;
  /** A remote turn never runs in a bypass mode. */
  readonly pinAskMode: boolean;
}

export interface StdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentSession {
  readonly id: string;
  readonly resumed: boolean;
  /**
   * Every update reaches `handlers.update` synchronously and in wire order, and the
   * promise settles only after the last one: the stop is queued behind its chunks.
   */
  prompt(blocks: readonly PromptBlock[], handlers: TurnHandlers): Promise<StopReason>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export type PromptBlock = { readonly kind: "text"; readonly text: string };

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface TurnHandlers {
  update(update: AgentUpdate): void;
  ask(ask: AgentAsk): Promise<AgentAskAnswer>;
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
}

export type AgentUpdate =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | {
      readonly kind: "tool_start";
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind: ToolKind;
      readonly mcp?: McpToolRef | undefined;
    }
  | {
      readonly kind: "tool_update";
      readonly toolCallId: string;
      readonly title?: string | undefined;
      readonly status?: "pending" | "in_progress" | "completed" | "failed" | undefined;
      readonly detail?: string | undefined;
    }
  | {
      readonly kind: "plan";
      readonly entries: readonly {
        readonly content: string;
        readonly status: "pending" | "in_progress" | "completed";
      }[];
    }
  | { readonly kind: "mode"; readonly modeId: string };

export type AskEffect = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export type AgentAsk =
  | {
      readonly kind: "permission";
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind: ToolKind;
      readonly mcp?: McpToolRef | undefined;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly effect: AskEffect;
      }[];
    }
  | {
      readonly kind: "question";
      readonly message: string;
      readonly schema: Readonly<Record<string, unknown>>;
    };

export type AgentAskAnswer =
  | { readonly kind: "selected"; readonly optionId: string }
  | {
      readonly kind: "values";
      readonly values: Readonly<Record<string, string | number | boolean>>;
    }
  | { readonly kind: "declined" }
  | { readonly kind: "cancelled" };

export type AgentExit =
  | { readonly kind: "killed" }
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly stderrTail: string;
    };

/** The bytes an ACP peer reads and writes: a child's stdio, or a test's pipe. */
export interface AcpStdio {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
}

export interface AgentModes {
  readonly current: string;
  readonly available: readonly string[];
}

/** The agent side of ACP in this file's own terms, for the fake agent. */
export interface AcpAgentHandlers {
  readonly capabilities: Pick<AgentCapabilities, "resume" | "close" | "mcpHttp">;
  newSession(
    input: OpenSessionInput,
  ): Promise<{ readonly id: string; readonly modes?: AgentModes | undefined }>;
  prompt(
    sessionId: string,
    blocks: readonly PromptBlock[],
    peer: {
      update(update: AgentUpdate): Promise<void>;
      ask(ask: AgentAsk): Promise<AgentAskAnswer>;
      readonly cancelled: AbortSignal;
    },
  ): Promise<StopReason>;
}

const STDERR_TAIL_BYTES = 4_096;
const KILL_GRACE_MS = 2_000;
const MAX_DETAIL_CHARS = 4_000;
const AUTH_REQUIRED = -32000;
const MCP_PREFIX = "mcp__";

const ASK_MODES_BY_PREFERENCE = ["default", "workspace-write", "read-only"];

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

function toolKindOf(kind: AcpToolKind | null | undefined): ToolKind {
  return kind && TOOL_KINDS.has(kind) ? kind : "other";
}

function stopReasonOf(reason: AcpStopReason): StopReason {
  return reason;
}

/**
 * Which MCP server serves a tool call, by the agents' own conventions: Claude Code's
 * `mcp__<server>__<tool>` name, Codex's `mcp.<server>.<tool>` title and raw input.
 */
function mcpRefOf(call: ToolCall | ToolCallUpdate): McpToolRef | undefined {
  const claude = isFields(call._meta?.claudeCode) ? call._meta.claudeCode : undefined;
  const name = typeof claude?.toolName === "string" ? claude.toolName : call.name;
  if (name?.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const separator = rest.indexOf("__");
    if (separator > 0 && rest.length > separator + 2) {
      return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
    }
  }
  const raw = call.rawInput;
  if (
    call.title?.startsWith("mcp.") &&
    isFields(raw) &&
    typeof raw.server === "string" &&
    typeof raw.tool === "string"
  ) {
    return { server: raw.server, tool: raw.tool };
  }
  return undefined;
}

function readableTitle(title: string, mcp: McpToolRef): string {
  const keys = [
    `${MCP_PREFIX}${mcp.server}__${mcp.tool}`,
    `mcp.${mcp.server}.${mcp.tool}`,
  ];
  return keys.includes(title) ? mcp.tool : title;
}

function detailOf(update: ToolCallUpdate): string | undefined {
  const texts = (update.content ?? []).flatMap((content) =>
    content.type === "content" && content.content.type === "text"
      ? [content.content.text]
      : [],
  );
  const text = texts.length > 0 ? texts.join("\n") : update.rawOutput;
  return typeof text === "string" && text.trim() !== ""
    ? text.slice(0, MAX_DETAIL_CHARS)
    : undefined;
}

function textOf(content: ContentBlock): string | undefined {
  return content.type === "text" ? content.text : undefined;
}

function updateOf(update: SessionUpdate): AgentUpdate | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      return text === undefined ? undefined : { kind: "text", text };
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content);
      return text === undefined ? undefined : { kind: "thought", text };
    }
    case "tool_call": {
      const mcp = mcpRefOf(update);
      return {
        kind: "tool_start",
        toolCallId: update.toolCallId,
        title: mcp ? readableTitle(update.title, mcp) : update.title,
        toolKind: toolKindOf(update.kind),
        mcp,
      };
    }
    case "tool_call_update":
      return {
        kind: "tool_update",
        toolCallId: update.toolCallId,
        title: update.title ?? undefined,
        status: update.status ?? undefined,
        detail: detailOf(update),
      };
    case "plan":
      return {
        kind: "plan",
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
        })),
      };
    case "current_mode_update":
      return { kind: "mode", modeId: update.currentModeId };
    default:
      return undefined;
  }
}

function sessionUpdateOf(update: AgentUpdate): SessionUpdate {
  switch (update.kind) {
    case "text":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: update.text },
      };
    case "thought":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: update.text },
      };
    case "tool_start":
      return {
        sessionUpdate: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.toolKind,
        status: "pending",
        ...(update.mcp ? { _meta: claudeToolName(update.mcp) } : {}),
      };
    case "tool_update":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.detail !== undefined
          ? {
              content: [
                { type: "content", content: { type: "text", text: update.detail } },
              ],
            }
          : {}),
      };
    case "plan":
      return {
        sessionUpdate: "plan",
        entries: update.entries.map((entry) => ({ ...entry, priority: "medium" })),
      };
    case "mode":
      return { sessionUpdate: "current_mode_update", currentModeId: update.modeId };
  }
}

const claudeToolName = (mcp: McpToolRef) => ({
  claudeCode: { toolName: `${MCP_PREFIX}${mcp.server}__${mcp.tool}` },
});

interface KnownCall {
  readonly title?: string | undefined;
  readonly mcp?: McpToolRef | undefined;
}

function commandIn(rawInput: unknown): string | undefined {
  return isFields(rawInput) && typeof rawInput.command === "string"
    ? rawInput.command
    : undefined;
}

function permissionQuestion(askedTitle: string, callDetail: string | undefined): string {
  const detail = callDetail?.trim() ?? "";
  if (detail === "" || askedTitle.includes(detail)) return askedTitle;
  if (askedTitle.trim() === "" || detail.includes(askedTitle)) return detail;
  return `${askedTitle}: ${detail}`;
}

function permissionAskOf(
  request: RequestPermissionRequest,
  known: KnownCall | undefined,
): AgentAsk {
  const call = request.toolCall;
  const mcp = mcpRefOf(call) ?? known?.mcp;
  const title = call.title ?? "";
  return {
    kind: "permission",
    toolCallId: call.toolCallId,
    title: permissionQuestion(
      mcp ? readableTitle(title, mcp) : title,
      known?.title ?? commandIn(call.rawInput),
    ),
    toolKind: toolKindOf(call.kind),
    mcp,
    options: request.options.map((option) => ({
      id: option.optionId,
      label: option.name,
      effect: option.kind,
    })),
  };
}

function permissionAnswerOf(
  request: RequestPermissionRequest,
  answer: AgentAskAnswer,
): RequestPermissionResponse {
  const selected = (optionId: string) => ({
    outcome: { outcome: "selected" as const, optionId },
  });
  if (answer.kind === "selected") return selected(answer.optionId);
  if (answer.kind === "declined") {
    const reject =
      request.options.find((option) => option.kind === "reject_once") ??
      request.options.find((option) => option.kind === "reject_always");
    if (reject) return selected(reject.optionId);
  }
  return { outcome: { outcome: "cancelled" } };
}

function elicitationAnswerOf(answer: AgentAskAnswer): CreateElicitationResponse {
  switch (answer.kind) {
    case "values":
      return { action: "accept", content: { ...answer.values } };
    case "selected":
      return { action: "accept", content: {} };
    case "declined":
      return { action: "decline" };
    case "cancelled":
      return { action: "cancel" };
  }
}

function stdioServerOf(server: StdioMcpServer): McpServerStdio {
  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  };
}

function stdioServersOf(servers: readonly McpServer[] | undefined): StdioMcpServer[] {
  return (servers ?? []).flatMap((server) =>
    "command" in server
      ? [
          {
            name: server.name,
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
          },
        ]
      : [],
  );
}

/** Takes `session/update` off the wire in order, before the SDK sees the reply after it. */
function tapUpdates(
  stream: Stream,
  deliver: (notification: SessionNotification) => void,
): Stream {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          const fields: unknown = message;
          if (
            isFields(fields) &&
            fields.method === methods.client.session.update &&
            !("id" in fields)
          ) {
            deliver(fields.params as SessionNotification);
            return;
          }
          controller.enqueue(message);
        },
      }),
    ),
  };
}

function tapSends(stream: Stream): Stream {
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable,
    writable: new WritableStream({
      write(message) {
        const fields: unknown = message;
        if (isFields(fields) && typeof fields.method === "string") {
          logEvent("acp_send", { method: fields.method });
        }
        return writer.write(message);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
}

function commandOf(profile: AgentProfile): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return profile.launch.kind === "adapter"
    ? {
        command: "npx",
        args: [
          "--yes",
          `${profile.launch.package}@${profile.launch.version}`,
          ...(profile.launch.args ?? []),
        ],
      }
    : { command: profile.launch.command, args: profile.launch.args };
}

interface LiveState {
  handlers: TurnHandlers | undefined;
  readonly calls: Map<string, KnownCall>;
  readonly pinned: string | undefined;
}

function askingModeOf(modes: SessionModeState): string | undefined {
  if (ASK_MODES_BY_PREFERENCE.includes(modes.currentModeId)) return modes.currentModeId;
  const available = new Set(modes.availableModes.map((mode) => mode.id));
  return ASK_MODES_BY_PREFERENCE.find((mode) => available.has(mode));
}

function sessionModesOf(modes: AgentModes | undefined): SessionModeState | undefined {
  return modes
    ? {
        currentModeId: modes.current,
        availableModes: modes.available.map((id) => ({ id, name: id })),
      }
    : undefined;
}

function signalExit(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** ACP v1 over stdio. */
export function acpLauncher(): AgentLauncher {
  return {
    launch: async (profile, options) => {
      const { command, args } = commandOf(profile);
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...options.env },
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
      let killing = false;
      const exited = new Promise<AgentExit>((resolve) => {
        child.once("error", (error) =>
          resolve({
            kind: "exited",
            code: null,
            stderrTail: `${stderr}${error.message}`,
          }),
        );
        child.once("exit", (code) =>
          resolve(
            killing ? { kind: "killed" } : { kind: "exited", code, stderrTail: stderr },
          ),
        );
      });
      const kill = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        killing = true;
        signalExit(child.pid, "SIGTERM");
        const force = setTimeout(() => signalExit(child.pid, "SIGKILL"), KILL_GRACE_MS);
        await exited;
        clearTimeout(force);
      };
      if (options.signal.aborted) void kill();
      options.signal.addEventListener("abort", () => void kill(), { once: true });

      const sessions = new Map<string, LiveState>();
      const deliver = (notification: SessionNotification) => {
        const state = sessions.get(notification.sessionId);
        if (!state) return;
        const { update } = notification;
        const mapped = updateOf(update);
        if (!mapped) return;
        if (mapped.kind === "tool_start") {
          state.calls.set(mapped.toolCallId, { title: mapped.title, mcp: mapped.mcp });
        } else if (mapped.kind === "tool_update" && mapped.title) {
          const known = state.calls.get(mapped.toolCallId);
          state.calls.set(mapped.toolCallId, { ...known, title: mapped.title });
        }
        if (mapped.kind === "mode" && state.pinned && mapped.modeId !== state.pinned) {
          void context
            .request(methods.agent.session.setMode, {
              sessionId: notification.sessionId,
              modeId: state.pinned,
            })
            .catch(() => undefined);
        }
        state.handlers?.update(mapped);
      };
      const stream = tapUpdates(
        tapSends(
          ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          ),
        ),
        deliver,
      );
      const ask = async (sessionId: string | undefined, question: AgentAsk) => {
        const handlers =
          sessionId === undefined ? undefined : sessions.get(sessionId)?.handlers;
        return handlers ? handlers.ask(question) : ({ kind: "cancelled" } as const);
      };
      const connection = acpClient({ name: "parlor-host" })
        .onRequest(methods.client.session.requestPermission, async ({ params }) => {
          const known = sessions
            .get(params.sessionId)
            ?.calls.get(params.toolCall.toolCallId);
          const answer = await ask(params.sessionId, permissionAskOf(params, known));
          return permissionAnswerOf(params, answer);
        })
        .onRequest(
          methods.client.elicitation.create,
          async ({ params }: { params: CreateElicitationRequest }) => {
            if (params.mode !== "form") return { action: "cancel" };
            const sessionId =
              "sessionId" in params && typeof params.sessionId === "string"
                ? params.sessionId
                : undefined;
            const schema = isFields(params.requestedSchema) ? params.requestedSchema : {};
            const answer = await ask(sessionId, {
              kind: "question",
              message: params.message,
              schema,
            });
            return elicitationAnswerOf(answer);
          },
        )
        .connect(stream);
      const context: ClientContext = connection.agent;
      exited.then(
        () => connection.close(),
        () => undefined,
      );

      let initialized;
      try {
        initialized = await context.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "parlor-host", version: "0.0.0" },
        });
      } catch (error) {
        await kill();
        const exit = await exited;
        const why =
          exit.kind === "exited" && exit.stderrTail ? `: ${exit.stderrTail.trim()}` : "";
        throw new Error(`${profile.name} did not start${why}`, { cause: error });
      }
      const agentCapabilities = initialized.agentCapabilities ?? {};
      const capabilities: AgentCapabilities = {
        resume: Boolean(agentCapabilities.sessionCapabilities?.resume),
        close: Boolean(agentCapabilities.sessionCapabilities?.close),
        mcpHttp: agentCapabilities.mcpCapabilities?.http === true,
        ready: true,
      };

      const loginProblem = (error: unknown) =>
        error instanceof RequestError && error.code === AUTH_REQUIRED
          ? new Error(
              `${profile.name} is not logged in on this computer: run \`${profile.binary}\` in a terminal to log in.`,
              { cause: error },
            )
          : error;

      const open = async (input: OpenSessionInput) => {
        const mcpServers = input.mcpServers.map(stdioServerOf);
        if (input.resume && capabilities.resume) {
          try {
            const resumed = await context.request(methods.agent.session.resume, {
              sessionId: input.resume,
              cwd: input.cwd,
              mcpServers,
            });
            return { id: input.resume, modes: resumed.modes, resumed: true };
          } catch {}
        }
        const created = await context.request(methods.agent.session.new, {
          cwd: input.cwd,
          mcpServers,
        });
        return { id: created.sessionId, modes: created.modes, resumed: false };
      };

      return {
        capabilities,
        exited,
        kill,
        openSession: async (input) => {
          let opened;
          try {
            opened = await open(input);
          } catch (error) {
            throw loginProblem(error);
          }
          const sessionId = opened.id;
          const close = async (): Promise<boolean> => {
            sessions.delete(sessionId);
            if (!capabilities.close) return false;
            return context.request(methods.agent.session.close, { sessionId }).then(
              () => true,
              () => false,
            );
          };
          const modes = input.pinAskMode ? opened.modes : undefined;
          const pinned = modes ? askingModeOf(modes) : undefined;
          if (modes && pinned === undefined) {
            throw new SessionRefused(
              `${profile.name} offers no mode that asks before it acts, so it cannot take a turn from an app.`,
              !(await close()),
            );
          }
          const state: LiveState = { handlers: undefined, calls: new Map(), pinned };
          sessions.set(sessionId, state);
          if (pinned !== undefined && pinned !== modes?.currentModeId) {
            try {
              await context.request(methods.agent.session.setMode, {
                sessionId,
                modeId: pinned,
              });
            } catch (error) {
              throw new SessionRefused(
                `${profile.name} did not switch to a mode that asks before it acts.`,
                !(await close()),
                { cause: error },
              );
            }
          }
          const session: AgentSession = {
            id: sessionId,
            resumed: opened.resumed,
            prompt: async (blocks, handlers) => {
              if (state.handlers)
                throw new Error("This session is already answering a prompt.");
              state.handlers = handlers;
              try {
                const request: PromptRequest = {
                  sessionId,
                  prompt: blocks.map((block) => ({ type: "text", text: block.text })),
                };
                const response = await context.request(
                  methods.agent.session.prompt,
                  request,
                );
                return stopReasonOf(response.stopReason);
              } finally {
                state.handlers = undefined;
              }
            },
            cancel: () =>
              context
                .notify(methods.agent.session.cancel, { sessionId })
                .catch(() => undefined),
            close: async () => {
              await close();
            },
          };
          return session;
        },
      };
    },
  };
}

/** Serves `handlers` as an ACP agent on `io`, until the other side hangs up. */
export function serveAcpAgent(handlers: AcpAgentHandlers, io: AcpStdio): Promise<void> {
  const running = new Map<string, AbortController>();
  const aliases = new Map<string, string>();
  const idOf = (sessionId: string) => aliases.get(sessionId) ?? sessionId;
  const app = acpAgent({ name: "parlor-fake-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: handlers.capabilities.mcpHttp, sse: false },
        sessionCapabilities: {
          ...(handlers.capabilities.resume ? { resume: {} } : {}),
          ...(handlers.capabilities.close ? { close: {} } : {}),
        },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const { id, modes } = await handlers.newSession({
        cwd: params.cwd,
        mcpServers: stdioServersOf(params.mcpServers),
        pinAskMode: false,
      });
      const state = sessionModesOf(modes);
      return { sessionId: id, ...(state ? { modes: state } : {}) };
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      if (!handlers.capabilities.resume) {
        throw RequestError.methodNotFound(methods.agent.session.resume);
      }
      const { id } = await handlers.newSession({
        cwd: params.cwd,
        mcpServers: stdioServersOf(params.mcpServers),
        pinAskMode: false,
      });
      aliases.set(params.sessionId, id);
      return {};
    })
    .onRequest(methods.agent.session.setMode, () => ({}))
    .onRequest(methods.agent.session.close, () => {
      if (!handlers.capabilities.close) {
        throw RequestError.methodNotFound(methods.agent.session.close);
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const sessionId = params.sessionId;
      const cancelled = new AbortController();
      running.set(sessionId, cancelled);
      try {
        const blocks = params.prompt.flatMap((block): PromptBlock[] =>
          block.type === "text" ? [{ kind: "text", text: block.text }] : [],
        );
        const stopReason = await handlers.prompt(idOf(sessionId), blocks, {
          update: (update) =>
            client.notify(methods.client.session.update, {
              sessionId,
              update: sessionUpdateOf(update),
            }),
          ask: async (question) => {
            if (question.kind === "question") {
              const answer = await client.request(methods.client.elicitation.create, {
                sessionId,
                mode: "form",
                message: question.message,
                requestedSchema: question.schema as never,
              });
              if (answer.action === "accept") {
                const content = isFields(answer.content) ? answer.content : {};
                return { kind: "values", values: content as never };
              }
              return answer.action === "decline"
                ? { kind: "declined" }
                : { kind: "cancelled" };
            }
            const request: RequestPermissionRequest = {
              sessionId,
              toolCall: {
                toolCallId: question.toolCallId,
                title: question.title,
                kind: question.toolKind,
                status: "pending",
                ...(question.mcp ? { _meta: claudeToolName(question.mcp) } : {}),
              },
              options: question.options.map((option) => ({
                optionId: option.id,
                name: option.label,
                kind: option.effect,
              })),
            };
            const answer = await client.request(
              methods.client.session.requestPermission,
              request,
            );
            return answer.outcome.outcome === "selected"
              ? { kind: "selected", optionId: answer.outcome.optionId }
              : { kind: "cancelled" };
          },
          cancelled: cancelled.signal,
        });
        return { stopReason };
      } finally {
        running.delete(sessionId);
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      running.get(params.sessionId)?.abort();
    });
  return app.connect(ndJsonStream(io.output, io.input)).closed;
}
