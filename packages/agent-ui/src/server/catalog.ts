import type { JsonSchema, RouteEntry, UiManifest, ViewEntry } from "../manifest.js";

/**
 * The most catalog text, in characters, the ui_ tool descriptions carry in full. Past it
 * they list names only and ui_pages answers the rest, so a large app's tools stay small.
 */
export const CATALOG_BUDGET = 6000;

export const MAX_PAGES_LISTED = 10;

export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function typeOf(schema: JsonSchema | undefined): string {
  if (!schema) return "value";
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  const union = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(union)) return union.map(typeOf).join(" | ");
  if (schema.type === "array")
    return `${typeOf(schema.items as JsonSchema | undefined)}[]`;
  return typeof schema.type === "string" ? schema.type : "value";
}

/** `filter?: "all" | "done", page?: number`: what a page's search params take. */
export function searchOf(search: JsonSchema | undefined): string | undefined {
  const properties = search?.properties as Record<string, JsonSchema> | undefined;
  if (!properties || Object.keys(properties).length === 0) return undefined;
  const required = new Set(Array.isArray(search?.required) ? search.required : []);
  return Object.entries(properties)
    .map(([name, schema]) => `${name}${required.has(name) ? "" : "?"}: ${typeOf(schema)}`)
    .join(", ");
}

const keyedMark = (view: ViewEntry) => (view.keyed ? " (keyed)" : "");

function fullViewCatalog(manifest: UiManifest): string {
  if (manifest.views.length === 0) return "";
  const lines = manifest.views.map(
    (view) => `- ${view.name}${keyedMark(view)}: ${sentence(view.description)}`,
  );
  return `\n\nViews this app can show:\n${lines.join("\n")}`;
}

function pageLine(route: RouteEntry): string {
  const parts = [`- ${route.path}`];
  if (route.description) parts.push(` - ${sentence(route.description)}`);
  const search = searchOf(route.search);
  if (search) parts.push(` Search: ${search}.`);
  if (route.views.length > 0) parts.push(` Views: ${route.views.join(", ")}.`);
  return parts.join("");
}

function fullRouteCatalog(manifest: UiManifest): string {
  if (manifest.routes.length === 0) return "";
  return `\n\nPages:\n${manifest.routes.map(pageLine).join("\n")}`;
}

const writableViews = (manifest: UiManifest) =>
  manifest.views.filter((view) => view.writable.length > 0);

function fullWritableCatalog(manifest: UiManifest): string {
  const lines = writableViews(manifest).map(
    (view) =>
      `- ${view.name}${keyedMark(view)}: ${sentence(view.description)} Fields: ${view.writable.join(", ")}.`,
  );
  return lines.length === 0 ? "" : `\n\nForms you can fill:\n${lines.join("\n")}`;
}

export interface Catalogs {
  readonly views: string;
  readonly routes: string;
  readonly writable: string;
  /** Whether the descriptions list names only, leaving the rest to ui_pages. */
  readonly brief: boolean;
}

const NONE: Catalogs = { views: "", routes: "", writable: "", brief: false };

/** The catalogs the ui_ tool descriptions carry: in full within the budget, else names only. */
export function catalogsOf(
  manifest: UiManifest | undefined,
  budget: number = CATALOG_BUDGET,
): Catalogs {
  if (!manifest) return NONE;
  const full: Catalogs = {
    views: fullViewCatalog(manifest),
    routes: fullRouteCatalog(manifest),
    writable: fullWritableCatalog(manifest),
    brief: false,
  };
  if (full.views.length + full.routes.length + full.writable.length <= budget)
    return full;
  const views = manifest.views.map((view) => `${view.name}${keyedMark(view)}`);
  const writable = writableViews(manifest).map(
    (view) => `- ${view.name}${keyedMark(view)}: ${view.writable.join(", ")}`,
  );
  return {
    views:
      views.length === 0
        ? ""
        : `\n\nViews this app can show (ui_pages describes them): ${views.join(", ")}.`,
    routes:
      manifest.routes.length === 0
        ? ""
        : "\n\nPages: every path to takes. Call ui_pages to find the page for a task; it gives each page's description, search params and views.",
    writable:
      writable.length === 0
        ? ""
        : `\n\nForms you can fill, with their fields (ui_pages describes them):\n${writable.join("\n")}`,
    brief: true,
  };
}

export interface PageView {
  readonly name: string;
  readonly keyed?: true;
  readonly description: string;
  readonly fields?: readonly string[];
}

export interface PageEntry {
  readonly path: string;
  readonly description?: string;
  readonly params?: readonly string[];
  readonly search?: string;
  readonly views?: readonly PageView[];
}

export interface PagesResult {
  readonly pages: readonly PageEntry[];
  /** How many more pages matched than were listed. */
  readonly more?: number;
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function entryOf(route: RouteEntry, views: ReadonlyMap<string, ViewEntry>): PageEntry {
  const search = searchOf(route.search);
  const shown = route.views.flatMap((name) => {
    const view = views.get(name);
    if (!view) return [];
    const page: PageView = {
      name,
      ...(view.keyed ? { keyed: true as const } : {}),
      description: view.description,
      ...(view.writable.length > 0 ? { fields: view.writable } : {}),
    };
    return [page];
  });
  return {
    path: route.path,
    ...(route.description ? { description: route.description } : {}),
    ...(route.params.length > 0 ? { params: route.params } : {}),
    ...(search ? { search } : {}),
    ...(shown.length > 0 ? { views: shown } : {}),
  };
}

function haystackOf(
  route: RouteEntry,
  views: ReadonlyMap<string, ViewEntry>,
): Set<string> {
  const text = [
    route.path,
    route.description ?? "",
    ...route.views.flatMap((name) => {
      const view = views.get(name);
      return [name, view?.description ?? "", ...(view?.writable ?? [])];
    }),
  ].join(" ");
  return new Set(wordsOf(text));
}

/**
 * The pages that match `query` best, by how many of its words each page's path, description
 * and views mention. Without a query, every page in manifest order.
 */
export function findPages(
  manifest: UiManifest | undefined,
  input: { readonly query?: string | undefined; readonly path?: string | undefined },
): PagesResult {
  const routes = manifest?.routes ?? [];
  const views = new Map((manifest?.views ?? []).map((view) => [view.name, view]));
  const listed = (matches: readonly RouteEntry[]): PagesResult => {
    const pages = matches
      .slice(0, MAX_PAGES_LISTED)
      .map((route) => entryOf(route, views));
    const more = matches.length - pages.length;
    return more > 0 ? { pages, more } : { pages };
  };
  if (input.path !== undefined) {
    return listed(routes.filter((route) => route.path === input.path));
  }
  const words = [...new Set(wordsOf(input.query ?? ""))];
  if (words.length === 0) return listed(routes);
  const scored = routes
    .map((route, order) => {
      const haystack = haystackOf(route, views);
      return { route, order, score: words.filter((word) => haystack.has(word)).length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return listed(scored.map(({ route }) => route));
}
