import { z } from "zod";

import { findPages, type PagesResult } from "../catalog.js";
import {
  type CompactClient,
  type CompactScreen,
  compactClient,
  compactScreen,
} from "../compact.js";
import { routeHref, type RouteEntry, type UiManifest } from "../manifest.js";
import {
  type AgentOrigin,
  type ClientSummary,
  type ScreenSnapshot,
  UI_OPS,
  type UiOp,
  type UiOpResults,
  uiOpReadOnly,
} from "../protocol.js";
import {
  type AgentToolName,
  UI_PAGES_TOOL,
  uiToolDescriptions,
  uiToolInputs,
  type UiToolName,
} from "../ui-tools.js";
import { type UiBroker, UiFailure } from "./broker.js";
import type { ClientDirectory, Selection } from "./directory.js";

export { type AgentToolName, UI_PAGES_TOOL, type UiToolName };

const toolName = <O extends UiOp>(op: O): `ui_${O}` => `ui_${op}`;

/** The tools that act on an open app client; {@link UI_PAGES_TOOL} joins them for a large app. */
export const UI_TOOLS: readonly UiToolName[] = UI_OPS.map(toolName);

export const UI_MANIFEST_RESOURCE = "parlor://manifest";

export interface AgentToolContext {
  readonly scope: string;
  readonly clientId?: string | undefined;
  readonly origin: AgentOrigin;
  readonly signal?: AbortSignal | undefined;
  readonly webOrigin?: string | undefined;
}

export interface AgentTool<I extends z.ZodObject = z.ZodObject> {
  readonly name: AgentToolName;
  readonly description: string;
  readonly input: I;
  readonly readOnly: boolean;
  run(input: z.output<I>, ctx: AgentToolContext): Promise<unknown>;
}

/** @deprecated ui_screen returns {@link ScreenToolOutput}. */
export interface ScreenToolResult extends ScreenSnapshot {
  readonly client: ClientSummary;
  readonly otherClients: readonly ClientSummary[];
  readonly tiedWith?: readonly string[] | undefined;
}

/** @deprecated ui_navigate returns {@link NavigateToolOutput}. */
export interface NavigateToolResult {
  readonly client: ClientSummary;
  readonly screen: ScreenSnapshot;
}

/** @deprecated ui_set returns {@link SetToolOutput}. */
export type SetToolResult = UiOpResults["set"] & { readonly client: ClientSummary };

/** @deprecated ui_highlight returns {@link HighlightToolOutput}. */
export type HighlightToolResult = UiOpResults["highlight"] & {
  readonly client: ClientSummary;
};

export interface ScreenToolOutput extends CompactScreen {
  readonly client: CompactClient;
  readonly otherClients?: readonly ClientSummary[];
  readonly tiedWith?: readonly string[];
}

export interface NavigateToolOutput {
  readonly client: CompactClient;
  readonly screen: CompactScreen;
}

export type SetToolOutput = UiOpResults["set"] & { readonly client: CompactClient };

export type HighlightToolOutput = UiOpResults["highlight"] & {
  readonly client: CompactClient;
};

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

const UNREACHABLE: UnreachableResult = { reachable: false, reason: "no_client" };

function defineTool<I extends z.ZodObject>(tool: AgentTool<I>): AgentTool {
  return tool as unknown as AgentTool;
}

function clientOf(
  directory: ClientDirectory,
  scope: string,
  selection: Selection,
): CompactClient {
  const alone = directory.summaries(scope).length <= 1;
  return compactClient(directory.summary(selection.target.client), alone);
}

function withClients(
  directory: ClientDirectory,
  scope: string,
  selection: Selection,
  snapshot: ScreenSnapshot,
): ScreenToolOutput {
  const chosen = selection.target.client;
  const otherClients = directory.summaries(scope).filter((c) => c.id !== chosen.id);
  return {
    client: clientOf(directory, scope, selection),
    ...(otherClients.length > 0 ? { otherClients } : {}),
    ...(selection.tied.length > 0 ? { tiedWith: selection.tied.map((c) => c.id) } : {}),
    ...compactScreen(snapshot),
  };
}

function missingParams(
  route: RouteEntry,
  params: Readonly<Record<string, string>> | undefined,
): void {
  const missing = route.params.filter((name) => !params?.[name]);
  if (missing.length === 0) return;
  throw new UiFailure({
    code: "unknown_route",
    message: `${route.path} needs params: ${missing.join(", ")}.`,
    issues: missing.map((name) => ({ path: `params.${name}`, message: "Required" })),
  });
}

function hrefFor(href: string, webOrigin: string | undefined): string {
  return webOrigin ? new URL(href, webOrigin).href : href;
}

export function createUiTools(
  deps: UiToolDeps,
): (manifest: UiManifest | undefined) => readonly AgentTool[] {
  const { directory, broker } = deps;
  const refuseTie = (selection: Selection) => {
    if (selection.tied.length === 0) return;
    const candidates = [selection.target.client, ...selection.tied];
    throw new UiFailure({
      code: "ambiguous_client",
      message:
        "The user has several app clients open and none stands out. Ask which one, then retry with clientId.",
      issues: candidates.map((client) => {
        const summary = directory.summary(client);
        return {
          path: "clientId",
          message: `${summary.id} (${summary.platform}, ${summary.focused ? "focused" : "not focused"}, ${summary.visible ? "visible" : "hidden"}, seen ${summary.seenAgoMs} ms ago)`,
        };
      }),
    });
  };
  const requireOp = (selection: Selection, op: UiOp) => {
    const { client } = selection.target;
    if (client.ops.includes(op)) return;
    throw new UiFailure({
      code: "unsupported_op",
      message: `The app client ${client.id} (${client.platform}${client.buildId ? `, build ${client.buildId}` : ""}) is too old for ui_${op}. Ask the user to update the app; ui_screen and ui_navigate still work.`,
    });
  };
  const select = (ctx: AgentToolContext, clientId: string | undefined) => {
    if (ctx.clientId !== undefined) return selectBound(ctx, ctx.clientId, clientId);
    if (clientId !== undefined && !directory.connected(ctx.scope, clientId)) {
      const connected = directory.summaries(ctx.scope).map((client) => client.id);
      throw new UiFailure({
        code: "unknown_client",
        message: `No app client ${clientId} is connected. Connected clients: ${connected.join(", ") || "none"}.`,
        issues: connected.map((id) => ({ path: "clientId", message: id })),
      });
    }
    return directory.select(ctx.scope, clientId);
  };
  const selectBound = (
    ctx: AgentToolContext,
    bound: string,
    requested: string | undefined,
  ) => {
    if (requested !== undefined && requested !== bound) {
      throw new UiFailure({
        code: "unknown_client",
        message: `This chat acts on the app client its prompt came from, not on ${requested}.`,
      });
    }
    if (!directory.connected(ctx.scope, bound)) {
      throw new UiFailure({
        code: "unknown_client",
        message: "The app client this chat was sent from is no longer connected.",
      });
    }
    return directory.select(ctx.scope, bound);
  };

  const build = (manifest: UiManifest | undefined): readonly AgentTool[] => {
    const text = uiToolDescriptions(manifest, "remote");
    const inputs = uiToolInputs(manifest);
    const screen = defineTool({
      name: "ui_screen",
      description: text.screen,
      input: inputs.screen.extend({ clientId: clientIdInput }),
      readOnly: uiOpReadOnly.screen,
      async run({ clientId }, ctx) {
        const selection = select(ctx, clientId);
        if (!selection) return UNREACHABLE;
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

    const navigate = defineTool({
      name: "ui_navigate",
      description: text.navigate,
      input: inputs.navigate.extend({ clientId: clientIdInput }),
      readOnly: uiOpReadOnly.navigate,
      async run({ to, params, search, replace, clientId }, ctx) {
        const selection = select(ctx, clientId);
        const route = manifest?.routes.find((entry) => entry.path === to);
        if (manifest && manifest.routes.length > 0 && !route) {
          throw new UiFailure({ code: "unknown_route", message: `No page at ${to}.` });
        }
        if (route) missingParams(route, params);
        if (!selection) {
          const href = routeHref(
            route ?? { path: to, params: [], views: [] },
            params,
            search,
          );
          return { ...UNREACHABLE, href: hrefFor(href, ctx.webOrigin) };
        }
        refuseTie(selection);
        const input = {
          to,
          ...(params ? { params } : {}),
          ...(search ? { search } : {}),
          ...(replace === undefined ? {} : { replace }),
        };
        const result = await broker.request(
          selection.target,
          "navigate",
          input,
          ctx.origin,
          ctx.signal,
        );
        const navigated: NavigateToolOutput = {
          client: clientOf(directory, ctx.scope, selection),
          screen: compactScreen(result.screen),
        };
        return navigated;
      },
    });

    const set = defineTool({
      name: toolName("set"),
      description: text.set,
      input: inputs.set.extend({ clientId: clientIdInput }),
      readOnly: uiOpReadOnly.set,
      async run({ view, key, value, clientId }, ctx) {
        const selection = select(ctx, clientId);
        if (!selection) return UNREACHABLE;
        refuseTie(selection);
        requireOp(selection, "set");
        const result = await broker.request(
          selection.target,
          "set",
          { view, ...(key === undefined ? {} : { key }), value },
          ctx.origin,
          ctx.signal,
        );
        const written: SetToolOutput = {
          client: clientOf(directory, ctx.scope, selection),
          ...result,
        };
        return written;
      },
    });

    const highlight = defineTool({
      name: toolName("highlight"),
      description: text.highlight,
      input: inputs.highlight.extend({ clientId: clientIdInput }),
      readOnly: uiOpReadOnly.highlight,
      async run({ view, key, field, clientId }, ctx) {
        const selection = select(ctx, clientId);
        if (!selection) return UNREACHABLE;
        refuseTie(selection);
        requireOp(selection, "highlight");
        const result = await broker.request(
          selection.target,
          "highlight",
          {
            view,
            ...(key === undefined ? {} : { key }),
            ...(field === undefined ? {} : { field }),
          },
          ctx.origin,
          ctx.signal,
        );
        const pointed: HighlightToolOutput = {
          client: clientOf(directory, ctx.scope, selection),
          ...result,
        };
        return pointed;
      },
    });

    const pages = defineTool({
      name: UI_PAGES_TOOL,
      description: text.pages,
      input: inputs.pages,
      readOnly: true,
      async run({ query, path }): Promise<PagesResult> {
        return findPages(manifest, { query, path });
      },
    });

    const byOp: { readonly [O in UiOp]: AgentTool } = {
      screen,
      navigate,
      set,
      highlight,
    };
    const tools = UI_OPS.map((op) => byOp[op]);
    return text.brief ? [...tools, pages] : tools;
  };

  let cachedFor: UiManifest | undefined;
  let cached = build(undefined);
  return (manifest) => {
    if (manifest !== cachedFor) {
      cached = build(manifest);
      cachedFor = manifest;
    }
    return cached;
  };
}

export function uiInstructions(): string {
  return [
    "This app's screen is visible to you through the ui_ tools, next to the app's actions.",
    'Call ui_screen to see what the user is looking at before acting on words like "this", "that" or "here".',
    "Resolve them from attention in this order: focus, selection, lastInteracted, focal.",
    "A keyed view's key is the entity id that the app's actions take, so pass it straight to the action.",
    "Do the work through actions; the screen updates by itself.",
    "To show the user a page, call ui_navigate with a path from its list.",
    "You fill forms and the user submits them: use ui_set to fill a form, and call the action that submits it only when the user explicitly asks you to.",
    "Some actions ask the user to approve them in the app before they run: call them as usual and wait. If one fails with declined, do not retry unless the user asks again; if it fails with confirmation_unavailable, ask the user to do it in the app themselves.",
    "Use ui_highlight to point at what you mean, or at candidates when you need the user to pick one.",
    "If a ui_ tool returns reachable: false, the app is not open: tell the user, and for navigation hand them the href.",
  ].join("\n");
}
