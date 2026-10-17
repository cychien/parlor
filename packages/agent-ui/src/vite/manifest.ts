import type { ManifestBuild, UiAppInfo, ViewEntry } from "../manifest.js";
import type { AnyAgentView } from "../view.js";

export function describeView(view: AnyAgentView): ViewEntry {
  void view;
  throw new Error("not implemented");
}

export function buildUiManifest(app: UiAppInfo, routeTree: unknown): ManifestBuild {
  void app;
  void routeTree;
  throw new Error("not implemented");
}
