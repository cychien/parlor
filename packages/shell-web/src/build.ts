import { join } from "node:path";

import { GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import { build } from "vite";

import { parlorWeb, type WebOptions } from "./plugin.js";

export function webOutDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "web");
}

export async function buildWeb(
  { config, rootDir }: LoadedConfig,
  options: WebOptions = {},
): Promise<string> {
  const outDir = webOutDir(rootDir);
  await build({
    root: rootDir,
    configFile: false,
    plugins: parlorWeb(config, options),
    build: { outDir, emptyOutDir: true },
    logLevel: "warn",
  });
  return outDir;
}
