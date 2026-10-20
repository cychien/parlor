import type { Delegation } from "@parlor/server";

import type { StdioMcpServer } from "./acp.js";

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

export function createMcpProxy(hostBinary: string): McpProxy {
  // TODO: net server on the socket, chmod 0600; a client's first line is its nonce; each
  //   JSON-RPC message -> POST `${appOrigin}/_parlor/mcp` with `authorization: Bearer
  //   ${token}` and accept json + event-stream, the response (SSE included) streamed back;
  //   tools/list cached per session.
  void hostBinary;
  throw new Error("not implemented");
}

/** `parlor-host mcp-proxy`: stdio to the daemon socket and back, nothing else. */
export async function runMcpProxyProcess(env: NodeJS.ProcessEnv): Promise<void> {
  void env;
  throw new Error("not implemented");
}
