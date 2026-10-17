import type { H3 } from "h3";

import type { AgentUi } from "./agent-ui.js";

export const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;

export interface AgentUiRouteOptions {
  readonly basePath: string;
  readonly agentUi: AgentUi;
  readonly scope: (request: Request) => string | Promise<string>;
  readonly clientId: (request: Request) => string | undefined;
}

export function registerAgentUiRoutes(app: H3, options: AgentUiRouteOptions): void {
  void app;
  void options;
  throw new Error("not implemented");
}
