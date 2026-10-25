import { join } from "node:path";

import { GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import { build, defaultServerConditions } from "vite";

import type { WebOptions } from "./plugin.js";
import { RENDER_FILE, RENDER_MODULE } from "./ssr.js";
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

export function ssrOutDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "ssr");
}

export interface RenderBuildOptions {
  /** Export conditions of the runtime the server runs on, such as `workerd`. */
  readonly conditions: readonly string[];
}

/** One self-contained module for the server bundle, resolved for the runtime it runs on. */
export async function buildRender(
  loaded: LoadedConfig,
  { conditions }: RenderBuildOptions,
): Promise<string> {
  const outDir = ssrOutDir(loaded.rootDir);
  await build(
    parlorViteConfig(
      loaded,
      { render: true },
      {
        build: {
          ssr: true,
          outDir,
          emptyOutDir: true,
          copyPublicDir: false,
          rolldownOptions: {
            input: RENDER_MODULE,
            output: { entryFileNames: RENDER_FILE, codeSplitting: false },
          },
        },
        // The same mode Vite compiles JSX for, so React's runtime matches it.
        define: {
          "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
        },
        ssr: {
          noExternal: true,
          resolve: {
            conditions: [
              ...conditions,
              ...defaultServerConditions.filter((condition) => condition !== "node"),
            ],
          },
        },
        logLevel: "warn",
      },
    ),
  );
  return join(outDir, RENDER_FILE);
}
