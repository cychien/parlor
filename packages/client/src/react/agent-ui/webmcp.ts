import {
  type AgentOrigin,
  compactScreen,
  findPages,
  type PageToolSpec,
  parseUiFrame,
  type ScreenSnapshot,
  type UiManifest,
  type UiOp,
  type UiReply,
} from "@parlor/agent-ui";
import type { AgentUiClient } from "@parlor/agent-ui/client";
import { agentDescription } from "@parlor/core";
import type { ActionDescriptor } from "@parlor/core/registry";

import type { ActionClient } from "../../action-client.js";

/** One tool as WebMCP's `registerTool` takes it. */
export interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly untrustedContentHint?: boolean;
  };
  execute(input: unknown): Promise<WebMcpResult>;
}

export interface WebMcpResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: true;
}

/** The browser's model context: `document.modelContext`, or `navigator.modelContext` in older drafts. */
export interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { readonly signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
}

interface AppManifest {
  readonly actions: readonly ActionDescriptor[];
  readonly ui?: UiManifest | undefined;
  readonly uiTools?: readonly PageToolSpec[] | undefined;
}

const ORIGIN: AgentOrigin = { via: "mcp", name: "Browser agent" };

export function modelContextOf(
  scope: { readonly document?: unknown; readonly navigator?: unknown } = globalThis,
): ModelContext | undefined {
  const holder = (value: unknown) =>
    (value as { modelContext?: ModelContext } | undefined)?.modelContext;
  const context = holder(scope.document) ?? holder(scope.navigator);
  return typeof context?.registerTool === "function" ? context : undefined;
}

function resultOf(value: unknown): WebMcpResult {
  const text = value === undefined ? "ok" : JSON.stringify(value);
  return {
    content: [{ type: "text", text }],
    ...(value !== null && typeof value === "object" && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

function errorOf(error: {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly unknown[] | undefined;
}): WebMcpResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

function actionTool(
  descriptor: ActionDescriptor,
  client: ActionClient<never>,
): WebMcpTool {
  return {
    name: descriptor.name,
    description: agentDescription(
      descriptor.description,
      descriptor.confirm ? "ask" : "proceed",
    ),
    inputSchema: descriptor.inputSchema,
    annotations: { readOnlyHint: !descriptor.mutating },
    async execute(input) {
      const response = await client.request(
        `${client.basePath}/actions/${descriptor.name}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-parlor-source": "mcp" },
          body: JSON.stringify(input ?? {}),
        },
      );
      const body = (await response.json().catch(() => undefined)) as
        | { readonly data?: unknown; readonly error?: Parameters<typeof errorOf>[0] }
        | undefined;
      if (response.ok) return resultOf(body?.data);
      return errorOf(
        body?.error ?? { code: "internal", message: `HTTP ${response.status}` },
      );
    },
  };
}

function shaped(op: UiOp, result: unknown): unknown {
  if (op === "screen") return compactScreen(result as ScreenSnapshot);
  if (op === "navigate") {
    return { screen: compactScreen((result as { screen: ScreenSnapshot }).screen) };
  }
  return result;
}

const invalid = (name: string): WebMcpResult =>
  errorOf({ code: "invalid_input", message: `Invalid input for "${name}"` });

/** The op's input, checked as the page checks one the server sends. */
function opInput(op: UiOp, input: unknown): unknown {
  const frame = JSON.stringify({ id: "webmcp", op, input, origin: ORIGIN, timeoutMs: 1 });
  const parsed = parseUiFrame(frame);
  return parsed.ok && "op" in parsed.frame ? parsed.frame.input : undefined;
}

function pagesInput(input: unknown): Parameters<typeof findPages>[1] | undefined {
  const { query, path } = (input ?? {}) as { query?: unknown; path?: unknown };
  if (
    (query !== undefined && typeof query !== "string") ||
    (path !== undefined && typeof path !== "string")
  )
    return undefined;
  return { query, path };
}

function uiTools(manifest: AppManifest, agentUi: AgentUiClient): WebMcpTool[] {
  return (manifest.uiTools ?? []).map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: { readOnlyHint: spec.readOnly, untrustedContentHint: true },
    async execute(input) {
      if (spec.name === "ui_pages") {
        const pages = pagesInput(input);
        return pages ? resultOf(findPages(manifest.ui, pages)) : invalid(spec.name);
      }
      const op = spec.name.slice(3) as UiOp;
      const checked = opInput(op, input ?? {});
      if (checked === undefined) return invalid(spec.name);
      const reply: UiReply = await agentUi.perform(op, checked as never, ORIGIN);
      return reply.ok ? resultOf(shaped(op, reply.result)) : errorOf(reply.error);
    },
  }));
}

export interface WebMcp {
  /** Registers the tools again for whoever is signed in now. */
  refresh(): void;
  /** Takes every tool back. */
  stop(): void;
}

/**
 * Hands the app's actions and screen to the browser's own agent through WebMCP, where the
 * browser has it, and does nothing where it does not. Actions run as calls from an agent,
 * so an action that asks for approval asks here; the ui_ tools run in this page.
 */
export function startWebMcp(
  client: ActionClient<never>,
  agentUi: AgentUiClient,
  context: ModelContext | undefined = modelContextOf(),
): WebMcp {
  if (!context) return { refresh: () => {}, stop: () => {} };
  let controller: AbortController | undefined;
  const registered: string[] = [];
  const stop = () => {
    controller?.abort();
    for (const name of registered.splice(0)) void context.unregisterTool?.(name);
  };
  const load = async (signal: AbortSignal) => {
    const response = await client
      .request(`${client.basePath}/manifest`, { signal })
      .catch(() => undefined);
    if (!response?.ok || signal.aborted) return;
    const manifest = (await response.json()) as AppManifest;
    const tools = [
      ...manifest.actions.map((descriptor) => actionTool(descriptor, client)),
      ...uiTools(manifest, agentUi),
    ];
    for (const tool of tools) {
      if (signal.aborted) return;
      try {
        await context.registerTool(tool, { signal });
        registered.push(tool.name);
      } catch {
        // A browser that refuses one tool, such as a duplicate name, keeps the others.
      }
    }
  };
  const refresh = () => {
    stop();
    controller = new AbortController();
    void load(controller.signal);
  };
  refresh();
  return { refresh, stop };
}
