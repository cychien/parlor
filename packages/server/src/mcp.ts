import {
  type CallToolResult,
  createMcpHandler as createSdkHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
} from "@modelcontextprotocol/server";
import { ActionError, type ActionMap, type DataProvider, isMutating } from "@parlor/core";
import { type ActionRegistry, invokeAction } from "@parlor/core/registry";

import { DEFAULT_SCOPE, type ScopeResolver } from "./scope.js";

export interface McpOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope: ScopeResolver;
  readonly database?: DataProvider | undefined;
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
  const { actions, scope, database, name = "parlor", version = "0.0.0" } = options;

  const factory = async (ctx: McpRequestContext) => {
    const resolvedScope = ctx.requestInfo ? await scope(ctx.requestInfo) : DEFAULT_SCOPE;
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
            const result = await invokeAction(
              actions,
              actionName,
              args,
              { scope: resolvedScope, source: "mcp" },
              { data: database },
            );
            return toolResult(result);
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
