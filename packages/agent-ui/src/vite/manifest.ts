import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { $ZodType, toJSONSchema } from "zod/v4/core";

import type {
  JsonSchema,
  ManifestBuild,
  RouteEntry,
  UiAppInfo,
  ViewEntry,
} from "../manifest.js";
import { type AnyAgentView, isAgentView } from "../view.js";

interface RouteLike {
  readonly isRoot?: boolean | undefined;
  readonly options?:
    | {
        readonly path?: string | undefined;
        readonly staticData?:
          | { readonly description?: unknown; readonly views?: unknown }
          | undefined;
        readonly validateSearch?: unknown;
      }
    | undefined;
  readonly children?: unknown;
}

function childrenOf(route: RouteLike): RouteLike[] {
  const { children } = route;
  if (!children || typeof children !== "object") return [];
  return (Array.isArray(children) ? children : Object.values(children)) as RouteLike[];
}

function joinPath(parent: string, path: string | undefined): string {
  const segments = [...parent.split("/"), ...(path ?? "").split("/")].filter(Boolean);
  return `/${segments.join("/")}`;
}

function paramsOf(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.startsWith("$"))
    .map((segment) => (segment === "$" ? "_splat" : segment.slice(1)));
}

function jsonSchemaOf(schema: unknown, io: "input" | "output"): JsonSchema | undefined {
  if (schema instanceof $ZodType) return toJSONSchema(schema, { io }) as JsonSchema;
  const converter = (schema as Partial<StandardJSONSchemaV1> | undefined)?.["~standard"]
    ?.jsonSchema;
  if (!converter) return undefined;
  try {
    return converter[io]({ target: "draft-2020-12" });
  } catch {
    return undefined;
  }
}

export function describeView(view: AnyAgentView): ViewEntry {
  const schema = jsonSchemaOf(view.schema, "output");
  return {
    name: view.name,
    description: view.description,
    keyed: view.keyed,
    ...(schema ? { schema } : {}),
  };
}

export function buildUiManifest(app: UiAppInfo, routeTree: unknown): ManifestBuild {
  const warnings: string[] = [];
  const routes: RouteEntry[] = [];
  const views = new Map<string, AnyAgentView>();

  const viewsOf = (route: RouteLike): AnyAgentView[] => {
    const listed = route.options?.staticData?.views;
    if (!Array.isArray(listed)) return [];
    const found = listed.filter(isAgentView);
    for (const view of found) {
      const known = views.get(view.name);
      if (known && known !== view) {
        throw new Error(`Two different agent views are named "${view.name}".`);
      }
      views.set(view.name, view);
    }
    return found;
  };

  const walk = (route: RouteLike, parentPath: string, inherited: readonly string[]) => {
    const names = [...new Set([...inherited, ...viewsOf(route).map((v) => v.name)])];
    const path = route.isRoot ? "/" : joinPath(parentPath, route.options?.path);
    const children = childrenOf(route);
    if (children.length > 0 || route.isRoot) {
      for (const child of children) walk(child, path, names);
      return;
    }
    if (routes.some((entry) => entry.path === path)) return;
    const description = route.options?.staticData?.description;
    if (typeof description !== "string" || description === "") {
      warnings.push(`Route "${path}" has no staticData.description.`);
    }
    const search = jsonSchemaOf(route.options?.validateSearch, "input");
    routes.push({
      path,
      ...(typeof description === "string" && description !== "" ? { description } : {}),
      params: paramsOf(path),
      ...(search ? { search } : {}),
      views: names,
    });
  };

  if (routeTree && typeof routeTree === "object") walk(routeTree as RouteLike, "/", []);

  const entries = [...views.values()].map(describeView);
  for (const entry of entries) {
    if (entry.schema) continue;
    warnings.push(
      `View "${entry.name}" has a schema that cannot be converted to JSON Schema, so the manifest lists it without one.`,
    );
  }

  return {
    manifest: { protocol: 1, app, routes, views: entries },
    warnings,
  };
}
