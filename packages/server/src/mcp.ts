import {
  CLIENT_INFO_META_KEY,
  type CallToolResult,
  createMcpHandler as createSdkHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { AgentOrigin, UiError } from "@parlor/agent-ui";
import { type AgentUi, UI_MANIFEST_RESOURCE, UiFailure } from "@parlor/agent-ui/server";
import {
  ActionError,
  type ActionErrorCode,
  type ActionMap,
  type AnyAction,
  isMutating,
} from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";

import type { ActionRunner } from "./actions.js";
import type { CallerResolver } from "./caller.js";
import { McpCalls } from "./mcp-calls.js";

export interface McpOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly runner: ActionRunner;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly agentUi?: AgentUi | undefined;
  readonly callers?: CallerResolver | undefined;
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

interface ToolErrorBody {
  readonly code: UiError["code"] | ActionErrorCode;
  readonly message: string;
  readonly issues?:
    | readonly { readonly path: string; readonly message: string }[]
    | undefined;
}

function errorBodyOf(error: unknown): ToolErrorBody {
  if (error instanceof UiFailure) return error.error;
  if (error instanceof ActionError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.issues
        ? {
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          }
        : {}),
    };
  }
  return { code: "internal", message: "Internal error" };
}

function toolError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: errorBodyOf(error) }, null, 2) },
    ],
  };
}

/**
 * The SDK answers bad arguments in plain text before the handler runs. A schema that lists
 * as the original but accepts anything leaves the check to the handler, which fails in the
 * one error body.
 */
function unvalidated(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  return { "~standard": { ...schema["~standard"], validate: (value) => ({ value }) } };
}

function actionDescription(action: AnyAction): string {
  return action.confirm
    ? `${action.description} When an agent calls it, the user must approve it in the app first; the call waits for that answer and fails with declined, confirmation_timeout or confirmation_unavailable without running.`
    : action.description;
}

export const PROGRESS_INTERVAL_MS = 10_000;

async function verifiedOrigin(
  callers: CallerResolver | undefined,
  request: Request | undefined,
  ctx: ServerContext,
): Promise<AgentOrigin> {
  const caller = callers && request ? await callers(request) : undefined;
  const principal = caller?.principal;
  if (principal?.kind === "agent" && principal.agent.verified) {
    return { via: "mcp", name: principal.agent.name };
  }
  return originOf(ctx);
}

export function originOf(ctx: ServerContext): AgentOrigin {
  const envelope: Readonly<Record<string, unknown>> | undefined = ctx.mcpReq.envelope;
  const info = envelope?.[CLIENT_INFO_META_KEY];
  const name =
    typeof info === "object" && info !== null
      ? (info as { name?: unknown }).name
      : undefined;
  return typeof name === "string" && name !== "" ? { via: "mcp", name } : { via: "mcp" };
}

export async function withProgress<T>(
  ctx: ServerContext,
  work: () => Promise<T>,
  intervalMs: number = PROGRESS_INTERVAL_MS,
): Promise<T> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return work();
  let progress = 0;
  const timer = setInterval(() => {
    ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: ++progress,
          message: "Waiting for the user to approve in the app",
        },
      })
      .catch(() => {});
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export function createMcpHandler<T extends ActionMap>(
  options: McpOptions<T>,
): McpHttpHandler {
  const {
    actions,
    runner,
    agentUi,
    callers,
    name = "parlor",
    version = "0.0.0",
  } = options;

  const calls = new McpCalls();

  const inCall = <R>(
    ctx: McpRequestContext,
    toolCtx: ServerContext,
    work: (signal: AbortSignal) => Promise<R>,
  ): Promise<R> =>
    calls.run(
      ctx.requestInfo,
      toolCtx.mcpReq.id,
      [...(ctx.requestInfo ? [ctx.requestInfo.signal] : []), toolCtx.mcpReq.signal],
      work,
    );

  const factory = (ctx: McpRequestContext) => {
    const instructions = agentUi?.instructions("mcp");
    const server = new McpServer({ name, version }, instructions ? { instructions } : {});
    server.server.setNotificationHandler("notifications/cancelled", (notification) => {
      const { requestId, reason } = notification.params;
      if (ctx.requestInfo && requestId !== undefined)
        calls.cancel(ctx.requestInfo, requestId, reason);
    });
    for (const actionName of actions.names()) {
      const action = actions.get(actionName);
      if (!action) continue;
      server.registerTool(
        actionName,
        {
          description: actionDescription(action),
          inputSchema: unvalidated(action.input),
          annotations: { readOnlyHint: !isMutating(action) },
        },
        async (args, toolCtx) => {
          try {
            const origin = await verifiedOrigin(callers, ctx.requestInfo, toolCtx);
            const result = await inCall(ctx, toolCtx, (signal) => {
              const run = () =>
                runner.run(actionName, args, ctx.requestInfo, "mcp", { signal, origin });
              return action.confirm ? withProgress(toolCtx, run) : run();
            });
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
          inputSchema: unvalidated(tool.input),
          annotations: { readOnlyHint: tool.readOnly },
        },
        async (args, toolCtx) => {
          try {
            const input = tool.input.safeParse(args);
            if (!input.success) {
              throw new ActionError("invalid_input", `Invalid input for "${tool.name}"`, {
                issues: input.error.issues,
              });
            }
            return toolResult(
              await inCall(ctx, toolCtx, async (signal) =>
                tool.run(
                  input.data,
                  await agentUi!.contextFor(
                    ctx.requestInfo,
                    await verifiedOrigin(callers, ctx.requestInfo, toolCtx),
                    signal,
                  ),
                ),
              ),
            );
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
