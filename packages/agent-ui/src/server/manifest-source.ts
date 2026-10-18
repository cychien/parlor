import { readFileSync, statSync } from "node:fs";

import type { UiManifest, ViewEntry } from "../manifest.js";

export type UiManifestInput = Omit<UiManifest, "views"> & {
  readonly views: readonly (Omit<ViewEntry, "writable"> & {
    readonly writable?: readonly string[] | undefined;
  })[];
};

export type UiManifestSource = () => UiManifestInput | undefined;

export function normalizeManifest(manifest: UiManifestInput): UiManifest {
  return {
    ...manifest,
    views: manifest.views.map((view) => ({ ...view, writable: view.writable ?? [] })),
  };
}

function readManifest(path: string): UiManifest {
  return normalizeManifest(JSON.parse(readFileSync(path, "utf8")) as UiManifestInput);
}

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
      manifest = readManifest(path);
      mtimeMs = stat.mtimeMs;
    } catch {
      return manifest;
    }
    return manifest;
  };
}
