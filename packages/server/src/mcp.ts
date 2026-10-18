import {
  type CallToolResult,
  createMcpHandler as createSdkHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { AgentOrigin } from "@parlor/agent-ui";
import { type AgentUi, UI_MANIFEST_RESOURCE, UiFailure } from "@parlor/agent-ui/server";
import { ActionError, type ActionMap, isMutating } from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";

import type { ActionRunner } from "./actions.js";

export interface McpOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly runner: ActionRunner;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly agentUi?: AgentUi | undefined;
}

function toolResult(result: unknown): CallToolResult {
  const text = result === undefined ? "ok" : JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(result !== null && typeof result === "object" && !Array.isArray(result)
      ? { structuredContent: result as Record<string, unknown> }
      : {}),
  };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof UiFailure) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: error.error }, null, 2) }],
    };
  }
  const message =
    error instanceof ActionError
      ? [
          error.message,
          ...(error.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`),
        ]
          .filter(Boolean)
          .join("\n")
      : "Internal error";
  return { isError: true, content: [{ type: "text", text: message }] };
}

export const PROGRESS_INTERVAL_MS = 10_000;

export function originOf(_ctx: ServerContext): AgentOrigin {
  return { via: "mcp" };
}

export async function withProgress<T>(
  _ctx: ServerContext,
  work: () => Promise<T>,
  _intervalMs: number = PROGRESS_INTERVAL_MS,
): Promise<T> {
  return work();
}

export function createMcpHandler<T extends ActionMap>(
  options: McpOptions<T>,
): McpHttpHandler {
  const { actions, runner, agentUi, name = "parlor", version = "0.0.0" } = options;

  const factory = (ctx: McpRequestContext) => {
    const instructions = agentUi?.instructions("mcp");
    const server = new McpServer({ name, version }, instructions ? { instructions } : {});
    for (const actionName of actions.names()) {
      const action = actions.get(actionName);
      if (!action) continue;
      server.registerTool(
        actionName,
        {
          description: action.description,
          inputSchema: action.input,
          annotations: { readOnlyHint: !isMutating(action) },
        },
        async (args) => {
          try {
            const result = await runner.run(actionName, args, ctx.requestInfo, "mcp");
            return toolResult(result.data);
          } catch (error) {
            return toolError(error);
          }
        },
      );
    }
    const uiTools = agentUi?.tools("mcp") ?? [];
    const uiManifest = uiTools.length > 0 ? agentUi?.manifest() : undefined;
    if (uiManifest) {
      server.registerResource(
        "ui-manifest",
        UI_MANIFEST_RESOURCE,
        {
          description:
            "The app's pages and the views they show, with full JSON schemas for each view's value.",
          mimeType: "application/json",
        },
        (uri) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(uiManifest, null, 2),
            },
          ],
        }),
      );
    }
    for (const tool of uiTools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          annotations: { readOnlyHint: tool.readOnly },
        },
        async (args, toolCtx) => {
          try {
            const context = await agentUi!.contextFor(
              ctx.requestInfo,
              { via: "mcp" },
              toolCtx.mcpReq.signal,
            );
            return toolResult(await tool.run(args, context));
          } catch (error) {
            if (!(error instanceof UiFailure))
              console.error("[parlor] UI tool failed:", error);
            return toolError(error);
          }
        },
      );
    }
    return server;
  };

  return createSdkHandler(factory);
}
