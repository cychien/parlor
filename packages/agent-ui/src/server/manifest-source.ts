import type { UiManifest } from "../manifest.js";

export type UiManifestSource = () => UiManifest | undefined;

export function fileManifestSource(path: string): UiManifestSource {
  void path;
  throw new Error("not implemented");
}
