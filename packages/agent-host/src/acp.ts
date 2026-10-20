import type {
  McpServerStdio,
  RequestPermissionRequest,
  SessionNotification,
  StopReason as AcpStopReason,
  Stream,
  ToolKind as AcpToolKind,
} from "@agentclientprotocol/sdk";

import type { AgentProfile } from "./agents.js";

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

/** The agent side of ACP in this file's own terms, for the fake agent. */
export interface AcpAgentHandlers {
  readonly capabilities: Pick<AgentCapabilities, "resume" | "mcpHttp">;
  newSession(input: OpenSessionInput): Promise<{ readonly id: string }>;
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

type AcpBoundary = {
  readonly stopReason: (reason: AcpStopReason) => StopReason;
  readonly toolKind: (kind: AcpToolKind | null | undefined) => ToolKind;
  readonly update: (notification: SessionNotification) => AgentUpdate | undefined;
  readonly ask: (request: RequestPermissionRequest) => AgentAsk;
  readonly mcpServer: (server: StdioMcpServer) => McpServerStdio;
  readonly stream: (io: AcpStdio) => Stream;
};

const boundary = (): AcpBoundary => {
  // TODO: the only ACP <-> domain mappings: session/update kinds to AgentUpdate,
  //   session/request_permission to a permission ask, elicitation/create (form) to a
  //   question, StdioMcpServer to McpServerStdio, ndJsonStream(io.output, io.input).
  throw new Error("not implemented");
};

/** ACP v1 over stdio. */
export function acpLauncher(): AgentLauncher {
  return {
    launch: async (profile, options) => {
      // TODO: spawn detached (own process group), never through a shell; an `adapter`
      //   launch runs its pinned package from the host's cache with the embedded runtime.
      //   client() with session/update and session/request_permission handlers through
      //   boundary(); initialize with clientCapabilities { elicitation: { form: {} } } and
      //   no fs or terminal; session/resume when advertised, never session/load.
      void profile;
      void options;
      void boundary;
      throw new Error("not implemented");
    },
  };
}

/** Serves `handlers` as an ACP agent on `io`. */
export function serveAcpAgent(handlers: AcpAgentHandlers, io: AcpStdio): Promise<void> {
  void handlers;
  void io;
  void boundary;
  throw new Error("not implemented");
}
