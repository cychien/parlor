import type { AgentConnection, AgentSession } from "./acp.js";
import type { ProxySession } from "./mcp-proxy.js";

export interface LiveSession {
  readonly session: AgentSession;
  readonly proxy: ProxySession;
}

/**
 * Processes per (app, agent), so two apps never share an agent process or its MCP
 * servers; sessions per (thread, agent), so a thread keeps its context across turns.
 */
export interface SessionPool {
  process(appOrigin: string, agentId: string): AgentConnection | undefined;
  adopt(appOrigin: string, agentId: string, connection: AgentConnection): void;
  session(threadId: string, agentId: string): LiveSession | undefined;
  remember(threadId: string, agentId: string, session: LiveSession): void;
  /** The last session id, from `sessions.json`, for `session/resume` after a restart. */
  resumable(threadId: string, agentId: string): string | undefined;
  drop(appOrigin: string, agentId?: string): Promise<void>;
}

export function createSessionPool(stateFile: string): SessionPool {
  void stateFile;
  throw new Error("not implemented");
}
