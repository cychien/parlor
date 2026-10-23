import { join } from "node:path";

import { GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import { build } from "vite";

import type { WebOptions } from "./plugin.js";
import { parlorViteConfig } from "./vite-config.js";

export function webOutDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "web");
}

export async function buildWeb(
  loaded: LoadedConfig,
  options: WebOptions = {},
): Promise<string> {
  const outDir = webOutDir(loaded.rootDir);
  await build(
    parlorViteConfig(loaded, options, {
      build: { outDir, emptyOutDir: true },
      logLevel: "warn",
    }),
  );
  return outDir;
}
