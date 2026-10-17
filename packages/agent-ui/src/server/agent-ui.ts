import type { ServerChannel } from "@parlor/sync";

import type { AgentOrigin, ClientMessage } from "../protocol.js";
import type { UiReceipt } from "./broker.js";
import type { AgentTool, AgentToolContext } from "./tools.js";

export type ExternalUiPolicy = boolean | "read-only";

export interface AgentUiOptions {
  readonly external?: ExternalUiPolicy | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AgentUiDependencies {
  readonly scope: (request: Request) => string | Promise<string>;
}

export interface AgentUi {
  readonly channel: ServerChannel;
  touch(clientId: string | undefined): void;
  receive(clientId: string, scope: string, message: ClientMessage): UiReceipt;
  tools(surface: "mcp" | "agent"): readonly AgentTool[];
  contextFor(
    request: Request | undefined,
    origin: AgentOrigin,
    signal?: AbortSignal,
  ): Promise<AgentToolContext>;
  instructions(surface: "mcp" | "agent"): string | undefined;
  close(): void;
}

export const DEFAULT_UI_TIMEOUT_MS = 10_000;

export function createAgentUi(options: AgentUiOptions & AgentUiDependencies): AgentUi {
  void options;
  throw new Error("not implemented");
}
