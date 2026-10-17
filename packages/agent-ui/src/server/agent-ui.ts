import type { ServerChannel } from "@parlor/sync";

import type { UiManifest } from "../manifest.js";
import { type AgentOrigin, type ClientMessage, UI_CHANNEL } from "../protocol.js";
import { UiBroker, type UiReceipt } from "./broker.js";
import { ClientDirectory } from "./directory.js";
import type { UiManifestSource } from "./manifest-source.js";
import {
  type AgentTool,
  type AgentToolContext,
  createUiTools,
  uiInstructions,
} from "./tools.js";

export type ExternalUiPolicy = boolean | "read-only";

export interface AgentUiOptions {
  readonly external?: ExternalUiPolicy | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AgentUiDependencies {
  readonly scope: (request: Request) => string | Promise<string>;
  readonly webOrigin?: string | undefined;
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
  manifest(): UiManifest | undefined;
  install(source: UiManifestSource): void;
  close(): void;
}

export const DEFAULT_UI_TIMEOUT_MS = 10_000;

export function webOriginFromEnv(
  value: string | undefined = process.env.PARLOR_WEB_ORIGIN,
): string | undefined {
  return value && /^https?:\/\//.test(value) ? value : undefined;
}

export function createAgentUi(options: AgentUiOptions & AgentUiDependencies): AgentUi {
  const external = options.external ?? true;
  const webOrigin = "webOrigin" in options ? options.webOrigin : webOriginFromEnv();
  const directory = new ClientDirectory();
  const broker = new UiBroker({ timeoutMs: options.timeoutMs ?? DEFAULT_UI_TIMEOUT_MS });
  const toolsFor = createUiTools({ directory, broker });
  let source: UiManifestSource = () => undefined;

  const tools = (surface: "mcp" | "agent") => {
    const allTools = toolsFor(source());
    if (surface === "agent" || external === true) return allTools;
    if (external === "read-only") return allTools.filter((tool) => tool.readOnly);
    return [];
  };

  return {
    channel: {
      event: UI_CHANNEL,
      connect: (connection) => directory.connect(connection),
    },
    touch: (clientId) => directory.touch(clientId),
    receive(clientId, scope, message) {
      switch (message.type) {
        case "presence": {
          const outcome = directory.presence(clientId, scope, message);
          const target = directory.target(clientId);
          if (outcome === "registered" && target) broker.reconnected(target);
          return { accepted: outcome !== "rejected" };
        }
        case "leave": {
          const left = directory.leave(clientId, scope);
          if (left) broker.abandon(clientId);
          return { accepted: left };
        }
        case "reply":
          return broker.reply(clientId, message);
      }
    },
    tools,
    async contextFor(request, origin, signal) {
      return {
        scope: request ? await options.scope(request) : "default",
        origin,
        signal,
        webOrigin: webOrigin ?? (request ? new URL(request.url).origin : undefined),
      };
    },
    instructions: (surface) => (tools(surface).length > 0 ? uiInstructions() : undefined),
    manifest: () => source(),
    install(next) {
      source = next;
    },
    close: () => broker.close(),
  };
}
