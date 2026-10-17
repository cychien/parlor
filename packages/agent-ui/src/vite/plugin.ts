import type { Plugin } from "vite";

import type { ManifestBuild, UiAppInfo } from "../manifest.js";

export const DEFAULT_ROUTE_TREE = "src/routeTree.gen.ts";
export interface AgentManifestOptions {
  readonly app: UiAppInfo;
  readonly routeTree?: string | undefined;
}

export function manifestFromModule(app: UiAppInfo, module: unknown): ManifestBuild {
  void app;
  void module;
  throw new Error("not implemented");
}

export function agentManifest(options: AgentManifestOptions): Plugin {
  void options;
  throw new Error("not implemented");
}
