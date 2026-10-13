import {
  type CallToolResult,
  createMcpHandler as createSdkHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
} from "@modelcontextprotocol/server";
import { ActionError, type ActionMap, isMutating } from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";

import type { ActionRunner } from "./actions.js";

export interface McpOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly runner: ActionRunner;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
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

export function createMcpHandler<T extends ActionMap>(
  options: McpOptions<T>,
): McpHttpHandler {
  const { actions, runner, name = "parlor", version = "0.0.0" } = options;

  const factory = (ctx: McpRequestContext) => {
    const server = new McpServer({ name, version });
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
    return server;
  };

  return createSdkHandler(factory);
}
