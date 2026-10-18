import { z } from "zod";

import {
  type AgentOrigin,
  type ClientSummary,
  type ScreenSnapshot,
  uiOpReadOnly,
} from "../protocol.js";
import { type UiBroker, UiFailure } from "./broker.js";
import type { ClientDirectory, Selection } from "./directory.js";
import { uiOpInputs } from "./schemas.js";

export const UI_TOOLS = ["ui_screen"] as const;
export type UiToolName = (typeof UI_TOOLS)[number];

export interface AgentToolContext {
  readonly scope: string;
  readonly clientId?: string | undefined;
  readonly origin: AgentOrigin;
  readonly signal?: AbortSignal | undefined;
  readonly webOrigin?: string | undefined;
}

export interface AgentTool<I extends z.ZodObject = z.ZodObject> {
  readonly name: UiToolName;
  readonly description: string;
  readonly input: I;
  readonly readOnly: boolean;
  run(input: z.output<I>, ctx: AgentToolContext): Promise<unknown>;
}

export interface ScreenToolResult extends ScreenSnapshot {
  readonly client: ClientSummary;
  readonly otherClients: readonly ClientSummary[];
  readonly tiedWith?: readonly string[] | undefined;
}

export interface UnreachableResult {
  readonly reachable: false;
  readonly reason: "no_client";
  readonly href?: string | undefined;
}

export interface UiToolDeps {
  readonly directory: ClientDirectory;
  readonly broker: UiBroker;
}

const clientIdInput = z
  .string()
  .optional()
  .describe(
    "Target a specific app client by id, as listed in client or otherClients of a ui_screen result. Omit to use the one the user is looking at.",
  );

const SCREEN_DESCRIPTION = [
  "Read what the user currently sees in the app: the route, the actions feeding the screen (name and input, never data), the views on screen with their values, and attention.",
  "route is the page the url matched, with notFound: false, its path pattern, params, search and url; when the url matches no page and the app shows its not-found screen, route is notFound: true with only the url.",
  "attention holds focus (the focused element), selection (the text the user selected and the view holding it; null unless the selection lies inside one view), lastInteracted (the view the user last clicked or focused), lastEntered (the view the user last scrolled into view; null until the user scrolls, since items already on screen when the page renders never count), and focal (the view nearest the middle of the viewport).",
  "Keyed views list only the items inside the viewport, in screen order, plus an offscreen count.",
  "The result names the app client it came from and every other open client.",
  "Returns reachable: false when the app is not open anywhere.",
].join(" ");

export function createUiTools(deps: UiToolDeps): readonly AgentTool[] {
  const { directory, broker } = deps;
  const select = (ctx: AgentToolContext, clientId: string | undefined) => {
    const wanted = clientId ?? ctx.clientId;
    if (wanted !== undefined && !directory.connected(ctx.scope, wanted)) {
      const connected = directory.summaries(ctx.scope).map((client) => client.id);
      throw new UiFailure({
        code: "unknown_client",
        message: `No app client ${wanted} is connected. Connected clients: ${connected.join(", ") || "none"}.`,
        issues: connected.map((id) => ({ path: "clientId", message: id })),
      });
    }
    return directory.select(ctx.scope, wanted);
  };
  const unreachable = (): UnreachableResult => ({
    reachable: false,
    reason: "no_client",
  });

  const screen = defineTool({
    name: "ui_screen",
    description: SCREEN_DESCRIPTION,
    input: uiOpInputs.screen.extend({ clientId: clientIdInput }),
    readOnly: uiOpReadOnly.screen,
    async run({ clientId }, ctx) {
      const selection = select(ctx, clientId);
      if (!selection) return unreachable();
      const snapshot = await broker.request(
        selection.target,
        "screen",
        {},
        ctx.origin,
        ctx.signal,
      );
      return withClients(directory, ctx.scope, selection, snapshot);
    },
  });

  return [screen];
}

function defineTool<I extends z.ZodObject>(tool: AgentTool<I>): AgentTool {
  return tool as unknown as AgentTool;
}

function withClients(
  directory: ClientDirectory,
  scope: string,
  selection: Selection,
  snapshot: ScreenSnapshot,
): ScreenToolResult {
  const chosen = selection.target.client;
  return {
    client: directory.summary(chosen),
    otherClients: directory.summaries(scope).filter((c) => c.id !== chosen.id),
    ...(selection.tied.length > 0 ? { tiedWith: selection.tied.map((c) => c.id) } : {}),
    ...snapshot,
  };
}

export function uiInstructions(): string {
  return [
    "This app's screen is visible to you through the ui_ tools, next to the app's actions.",
    'Call ui_screen to see what the user is looking at before acting on words like "this", "that" or "here".',
    "Resolve them from attention in this order: focus, selection, lastInteracted, focal.",
    "A keyed view's key is the entity id that the app's actions take, so pass it straight to the action.",
    "Do the work through actions; the screen updates by itself.",
    "If a ui_ tool returns reachable: false, the app is not open; tell the user instead of guessing what they see.",
  ].join("\n");
}
