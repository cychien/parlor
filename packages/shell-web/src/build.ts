import { join } from "node:path";

import { GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import { build } from "vite";

import { parlorWeb } from "./plugin.js";

export function webOutDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "web");
}

export async function buildWeb({ config, rootDir }: LoadedConfig): Promise<string> {
  const outDir = webOutDir(rootDir);
  await build({
    root: rootDir,
    plugins: parlorWeb(config),
    build: { outDir, emptyOutDir: true },
    logLevel: "warn",
  });
  return outDir;
}
