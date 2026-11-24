import { z } from "zod";

import { type Catalogs, catalogsOf } from "./catalog.js";
import type { UiManifest } from "./manifest.js";
import { uiOpInputs } from "./op-inputs.js";
import { UI_OPS, type UiOp, uiOpReadOnly } from "./protocol.js";

export type UiToolName = `ui_${UiOp}`;

export const UI_PAGES_TOOL = "ui_pages";

export type AgentToolName = UiToolName | typeof UI_PAGES_TOOL;

/**
 * Where the agent calls from: `remote` reaches the app through the server and may find it
 * closed or open in several clients; `page` runs inside the one page it reads.
 */
export type UiToolSurface = "remote" | "page";

export interface UiToolSpec {
  readonly name: AgentToolName;
  readonly description: string;
  readonly input: z.ZodObject;
  /** `input` as JSON Schema, for a tool API that takes one. */
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

/** A ui_ tool as the server hands it to a page: everything but the zod schema. */
export type PageToolSpec = Omit<UiToolSpec, "input">;

const jsonSchemaOf = (input: z.ZodObject) =>
  z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>;

const remoteOnly = (surface: UiToolSurface, ...lines: string[]) =>
  surface === "remote" ? lines : [];

function screenDescription(catalogs: Catalogs, surface: UiToolSurface): string {
  return (
    [
      "Read what the user sees in the app: the route, the actions feeding the screen (name and input, never data), the views on screen with their values, and attention.",
      "route is the page the url matched: its path pattern, url, params and search, or notFound: true with only the url on the app's not-found screen.",
      "attention holds focus (the focused element), selection (text selected inside one view, and that view), lastInteracted (the view last clicked or focused), lastEntered (the view last scrolled into view) and focal (the view nearest the middle of the viewport).",
      "Keyed views list only the items inside the viewport, in screen order, plus an offscreen count; shown is the visible fraction of what is partly visible.",
      "Empty or default fields (null attention, zero offscreen, success status, full visibility) are left out; view values are always whole.",
      ...remoteOnly(
        surface,
        "The result names the app client it came from, with ids when several are open.",
        "Returns reachable: false when the app is not open anywhere.",
      ),
    ].join(" ") + catalogs.views
  );
}

function navigateDescription(catalogs: Catalogs, surface: UiToolSurface): string {
  return (
    [
      "Take the user's app to a page, filling $params in the path from params.",
      "Waits for the page's data to load (up to 1.5 s) and returns the new screen in ui_screen's shape, so its route shows the page the app landed on.",
      ...remoteOnly(
        surface,
        "Returns reachable: false with an href to hand the user when the app is not open.",
      ),
    ].join(" ") + catalogs.routes
  );
}

function setDescription(catalogs: Catalogs, surface: UiToolSurface): string {
  return (
    [
      "Fill fields of a form the user sees, as a proposal: the user reviews it and submits it themselves. Call the matching action instead only when the user explicitly asks you to submit.",
      "value is merged into the view's current value field by field; fields you omit keep what the user typed.",
      "Returns the view's value read back from the screen and agentFields, the fields that still hold what you wrote; a field missing from agentFields was changed by the user.",
      surface === "remote"
        ? "Refuses with not_mounted, not_writable, user_editing (the user is typing in that field: wait or ask), invalid_value (issues name the fields), or ambiguous_client."
        : "Refuses with not_mounted, not_writable, user_editing (the user is typing in that field: wait or ask), or invalid_value (issues name the fields).",
      ...remoteOnly(surface, "Returns reachable: false when the app is not open."),
    ].join(" ") + catalogs.writable
  );
}

function highlightDescription(surface: UiToolSurface): string {
  return [
    "Point at something on the user's screen: scrolls a view (a keyed item by key) or one field inside it into the middle of the screen, focuses the field (not on a touch screen, where that opens the keyboard), and marks it for two seconds.",
    "Use it to show the user what you mean or to ask which one they meant.",
    surface === "remote"
      ? "Returns shown, the visible fraction after scrolling, or not_mounted when it is not on screen, or reachable: false when the app is not open."
      : "Returns shown, the visible fraction after scrolling, or not_mounted when it is not on screen.",
    "Refuses with user_editing when the user is typing in another field: wait or ask, and it moves nothing.",
  ].join(" ");
}

function pagesDescription(): string {
  return [
    "Find the app's pages for a task: what each page shows, its params and search params, and the views on it with the fields you can fill.",
    "query matches words in a page's path, description and views, best matches first; path gives that one page; with neither it lists every page.",
    "It reads the app's own page list, so it works whether or not the app is open.",
  ].join(" ");
}

function routeEnum(manifest: UiManifest | undefined) {
  const paths = manifest?.routes.map((route) => route.path) ?? [];
  const [first, ...rest] = paths;
  return first === undefined ? z.string() : z.enum([first, ...rest]);
}

export const uiPagesInput = z.object({
  query: z.string().optional().describe("Words for what the page is for."),
  path: z.string().optional().describe("One page's route path, as ui_navigate takes it."),
});

/** Each ui_ tool's input, with the paths ui_navigate takes for `manifest`. */
export function uiToolInputs(manifest: UiManifest | undefined) {
  return {
    screen: uiOpInputs.screen,
    navigate: uiOpInputs.navigate.extend({
      to: routeEnum(manifest).describe("The page's route path, exactly as listed."),
    }),
    set: uiOpInputs.set,
    highlight: uiOpInputs.highlight,
    pages: uiPagesInput,
  };
}

/** What each ui_ tool tells an agent, keyed by op and `pages`. */
export function uiToolDescriptions(
  manifest: UiManifest | undefined,
  surface: UiToolSurface,
) {
  const catalogs = catalogsOf(manifest);
  return {
    brief: catalogs.brief,
    screen: screenDescription(catalogs, surface),
    navigate: navigateDescription(catalogs, surface),
    set: setDescription(catalogs, surface),
    highlight: highlightDescription(surface),
    pages: pagesDescription(),
  };
}

/**
 * The ui_ tools an agent gets for `manifest`: one per op, plus ui_pages when the catalog is
 * too large to describe in full. The server and the page add how each one runs.
 */
export function uiToolSpecs(
  manifest: UiManifest | undefined,
  surface: UiToolSurface,
): readonly UiToolSpec[] {
  const inputs = uiToolInputs(manifest);
  const text = uiToolDescriptions(manifest, surface);
  const spec = (op: UiOp): UiToolSpec => ({
    name: `ui_${op}`,
    description: text[op],
    input: inputs[op],
    inputSchema: jsonSchemaOf(inputs[op]),
    readOnly: uiOpReadOnly[op],
  });
  const ops = UI_OPS.map(spec);
  const pages: UiToolSpec = {
    name: UI_PAGES_TOOL,
    description: text.pages,
    input: inputs.pages,
    inputSchema: jsonSchemaOf(inputs.pages),
    readOnly: true,
  };
  return text.brief ? [...ops, pages] : ops;
}
