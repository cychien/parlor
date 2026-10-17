import type { StaticDataRouteOption } from "@tanstack/router-core";

import type { AnyAgentView } from "./view.js";

declare module "@tanstack/router-core" {
  interface StaticDataRouteOption {
    readonly description?: string | undefined;
    readonly views?: readonly AnyAgentView[] | undefined;
  }
}

export type AgentRouteData = Pick<StaticDataRouteOption, "description" | "views">;

export const UI_MANIFEST_FILE = "ui-manifest.json";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface UiAppInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly scheme?: string | undefined;
}

export interface RouteEntry {
  readonly path: string;
  readonly description?: string | undefined;
  readonly params: readonly string[];
  readonly search?: JsonSchema | undefined;
  readonly views: readonly string[];
}

export interface ViewEntry {
  readonly name: string;
  readonly description: string;
  readonly keyed: boolean;
  readonly schema?: JsonSchema | undefined;
}

export interface UiManifest {
  readonly protocol: 1;
  readonly app: UiAppInfo;
  readonly buildId?: string | undefined;
  readonly routes: readonly RouteEntry[];
  readonly views: readonly ViewEntry[];
}

export interface ManifestBuild {
  readonly manifest: UiManifest;
  readonly warnings: readonly string[];
}

export function routeHref(
  route: RouteEntry,
  params: Readonly<Record<string, string>> | undefined,
  search: Readonly<Record<string, unknown>> | undefined,
): string {
  void route;
  void params;
  void search;
  throw new Error("not implemented");
}
