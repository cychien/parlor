import { readFileSync, statSync } from "node:fs";

import type { UiManifest } from "../manifest.js";

export type UiManifestSource = () => UiManifest | undefined;

export function fileManifestSource(path: string): UiManifestSource {
  let mtimeMs: number | undefined;
  let manifest: UiManifest | undefined;
  return () => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      mtimeMs = undefined;
      manifest = undefined;
      return undefined;
    }
    if (stat.mtimeMs === mtimeMs) return manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8")) as UiManifest;
      mtimeMs = stat.mtimeMs;
    } catch {
      return manifest;
    }
    return manifest;
  };
}
