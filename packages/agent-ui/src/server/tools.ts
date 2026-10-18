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
import type { ClientDirectory, Selection } from "./directory.js";
import { uiOpInputs } from "./schemas.js";

export type UiToolName = `ui_${UiOp}`;

const toolName = <O extends UiOp>(op: O): `ui_${O}` => `ui_${op}`;

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

export interface NavigateToolResult {
  readonly client: ClientSummary;
  readonly screen: ScreenSnapshot;
}

export type SetToolResult = UiOpResults["set"] & { readonly client: ClientSummary };

export type HighlightToolResult = UiOpResults["highlight"] & {
  readonly client: ClientSummary;
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

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function viewCatalog(manifest: UiManifest | undefined): string {
  if (!manifest || manifest.views.length === 0) return "";
  const lines = manifest.views.map(
    (view) =>
      `- ${view.name}${view.keyed ? " (keyed)" : ""}: ${sentence(view.description)}`,
  );
  return `\n\nViews this app can show:\n${lines.join("\n")}`;
}

function routeCatalog(manifest: UiManifest | undefined): string {
  if (!manifest || manifest.routes.length === 0) return "";
  const lines = manifest.routes.map((route) => {
    const parts = [`- ${route.path}`];
    if (route.description) parts.push(` - ${sentence(route.description)}`);
    if (route.views.length > 0) parts.push(` Views: ${route.views.join(", ")}.`);
    return parts.join("");
  });
  return `\n\nPages:\n${lines.join("\n")}`;
}

function screenDescription(manifest: UiManifest | undefined): string {
  return (
    [
      "Read what the user currently sees in the app: the route, the actions feeding the screen (name and input, never data), the views on screen with their values, and attention.",
      "route is the page the url matched, with notFound: false, its path pattern, params, search and url; when the url matches no page and the app shows its not-found screen, route is notFound: true with only the url.",
      "attention holds focus (the focused element), selection (the text the user selected and the view holding it; null unless the selection lies inside one view), lastInteracted (the view the user last clicked or focused), lastEntered (the view the user last scrolled into view; null until the user scrolls, since items already on screen when the page renders never count), and focal (the view nearest the middle of the viewport).",
      "Keyed views list only the items inside the viewport, in screen order, plus an offscreen count.",
      "The result names the app client it came from and every other open client.",
      "Returns reachable: false when the app is not open anywhere.",
    ].join(" ") + viewCatalog(manifest)
  );
}

function navigateDescription(manifest: UiManifest | undefined): string {
  return (
    [
      "Take the user's app to a page, filling $params in the path from params.",
      "Waits for the page's data to load (up to 1.5 s) and returns the new screen in ui_screen's shape, so its route shows the page the app landed on.",
      "Returns reachable: false with an href to hand the user when the app is not open.",
    ].join(" ") + routeCatalog(manifest)
  );
}

function writableCatalog(manifest: UiManifest | undefined): string {
  const lines = (manifest?.views ?? [])
    .filter((view) => view.writable.length > 0)
    .map(
      (view) =>
        `- ${view.name}${view.keyed ? " (keyed)" : ""}: ${sentence(view.description)} Fields: ${view.writable.join(", ")}.`,
    );
  return lines.length === 0 ? "" : `\n\nForms you can fill:\n${lines.join("\n")}`;
}

function setDescription(manifest: UiManifest | undefined): string {
  return (
    [
      "Fill fields of a form the user sees, as a proposal: the user reviews it and submits it themselves. Call the matching action instead only when the user explicitly asks you to submit.",
      "value is merged into the view's current value field by field; fields you omit keep what the user typed.",
      "Returns the view's value read back from the screen and agentFields, the fields that still hold what you wrote; a field missing from agentFields was changed by the user.",
      "Refuses with not_mounted, not_writable, user_editing (the user is typing in that field: wait or ask), invalid_value (issues name the fields), or ambiguous_client.",
      "Returns reachable: false when the app is not open.",
    ].join(" ") + writableCatalog(manifest)
  );
}

function routeEnum(manifest: UiManifest | undefined) {
  const paths = manifest?.routes.map((route) => route.path) ?? [];
  const [first, ...rest] = paths;
  return first === undefined ? z.string() : z.enum([first, ...rest]);
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

  const build = (manifest: UiManifest | undefined): readonly AgentTool[] => {
    const screen = defineTool({
      name: "ui_screen",
      description: screenDescription(manifest),
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
      description: navigateDescription(manifest),
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
        const navigated: NavigateToolResult = {
          client: directory.summary(selection.target.client),
          screen: result.screen,
        };
        return navigated;
      },
    });

    const set = defineTool({
      name: toolName("set"),
      description: setDescription(manifest),
      input: uiOpInputs.set.extend({ clientId: clientIdInput }),
      readOnly: uiOpReadOnly.set,
      async run({ view, key, value, clientId }, ctx) {
        const selection = select(ctx, clientId);
        if (!selection) return UNREACHABLE;
        refuseTie(selection);
        const result = await broker.request(
          selection.target,
          "set",
          { view, ...(key === undefined ? {} : { key }), value },
          ctx.origin,
          ctx.signal,
        );
        const written: SetToolResult = {
          client: directory.summary(selection.target.client),
          ...result,
        };
        return written;
      },
    });

    const highlight = defineTool({
      name: toolName("highlight"),
      description: "",
      input: uiOpInputs.highlight.extend({ clientId: clientIdInput }),
      readOnly: uiOpReadOnly.highlight,
      async run(_input, _ctx) {
        throw new Error("not implemented");
      },
    });

    const byOp: { readonly [O in UiOp]: AgentTool } = {
      screen,
      navigate,
      set,
      highlight,
    };
    return UI_OPS.map((op) => byOp[op]);
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
    "If a ui_ tool returns reachable: false, the app is not open: tell the user, and for navigation hand them the href.",
  ].join("\n");
}
