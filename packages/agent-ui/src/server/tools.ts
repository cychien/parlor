import { z } from "zod";

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
import { type UiBroker, UiFailure } from "./broker.js";
import { type Catalogs, catalogsOf, findPages, type PagesResult } from "./catalog.js";
import {
  type CompactClient,
  type CompactScreen,
  compactClient,
  compactScreen,
} from "./compact.js";
import type { ClientDirectory, Selection } from "./directory.js";
import { uiOpInputs } from "./schemas.js";

export type UiToolName = `ui_${UiOp}`;

export const UI_PAGES_TOOL = "ui_pages";

export type AgentToolName = UiToolName | typeof UI_PAGES_TOOL;

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

function screenDescription(catalogs: Catalogs): string {
  return (
    [
      "Read what the user sees in the app: the route, the actions feeding the screen (name and input, never data), the views on screen with their values, and attention.",
      "route is the page the url matched: its path pattern, url, params and search, or notFound: true with only the url on the app's not-found screen.",
      "attention holds focus (the focused element), selection (text selected inside one view, and that view), lastInteracted (the view last clicked or focused), lastEntered (the view last scrolled into view) and focal (the view nearest the middle of the viewport).",
      "Keyed views list only the items inside the viewport, in screen order, plus an offscreen count; shown is the visible fraction of what is partly visible.",
      "Empty or default fields (null attention, zero offscreen, success status, full visibility) are left out; view values are always whole.",
      "The result names the app client it came from, with ids when several are open.",
      "Returns reachable: false when the app is not open anywhere.",
    ].join(" ") + catalogs.views
  );
}

function navigateDescription(catalogs: Catalogs): string {
  return (
    [
      "Take the user's app to a page, filling $params in the path from params.",
      "Waits for the page's data to load (up to 1.5 s) and returns the new screen in ui_screen's shape, so its route shows the page the app landed on.",
      "Returns reachable: false with an href to hand the user when the app is not open.",
    ].join(" ") + catalogs.routes
  );
}

function setDescription(catalogs: Catalogs): string {
  return (
    [
      "Fill fields of a form the user sees, as a proposal: the user reviews it and submits it themselves. Call the matching action instead only when the user explicitly asks you to submit.",
      "value is merged into the view's current value field by field; fields you omit keep what the user typed.",
      "Returns the view's value read back from the screen and agentFields, the fields that still hold what you wrote; a field missing from agentFields was changed by the user.",
      "Refuses with not_mounted, not_writable, user_editing (the user is typing in that field: wait or ask), invalid_value (issues name the fields), or ambiguous_client.",
      "Returns reachable: false when the app is not open.",
    ].join(" ") + catalogs.writable
  );
}

function pagesDescription(): string {
  return [
    "Find the app's pages for a task: what each page shows, its params and search params, and the views on it with the fields you can fill.",
    "query matches words in a page's path, description and views, best matches first; path gives that one page; with neither it lists every page.",
    "It reads the app's own page list, so it works whether or not the app is open.",
  ].join(" ");
}

function highlightDescription(): string {
  return [
    "Point at something on the user's screen: scrolls a view (a keyed item by key) or one field inside it into the middle of the screen, focuses the field (not on a touch screen, where that opens the keyboard), and marks it for two seconds.",
    "Use it to show the user what you mean or to ask which one they meant.",
    "Returns shown, the visible fraction after scrolling, or not_mounted when it is not on screen, or reachable: false when the app is not open.",
    "Refuses with user_editing when the user is typing in another field: wait or ask, and it moves nothing.",
  ].join(" ");
}

function routeEnum(manifest: UiManifest | undefined) {
  const paths = manifest?.routes.map((route) => route.path) ?? [];
  const [first, ...rest] = paths;
  return first === undefined ? z.string() : z.enum([first, ...rest]);
}

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
    const catalogs = catalogsOf(manifest);
    const screen = defineTool({
      name: "ui_screen",
      description: screenDescription(catalogs),
      input: uiOpInputs.screen.extend({ clientId: clientIdInput }),
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
      description: navigateDescription(catalogs),
      input: uiOpInputs.navigate.extend({
        to: routeEnum(manifest).describe("The page's route path, exactly as listed."),
        clientId: clientIdInput,
      }),
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
      description: setDescription(catalogs),
      input: uiOpInputs.set.extend({ clientId: clientIdInput }),
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
      description: highlightDescription(),
      input: uiOpInputs.highlight.extend({ clientId: clientIdInput }),
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
      description: pagesDescription(),
      input: z.object({
        query: z.string().optional().describe("Words for what the page is for."),
        path: z
          .string()
          .optional()
          .describe("One page's route path, as ui_navigate takes it."),
      }),
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
    return catalogs.brief ? [...tools, pages] : tools;
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
