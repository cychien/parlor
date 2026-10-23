import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_ROUTE_TREE } from "@parlor/agent-ui/vite";
import { GENERATED_DIR, type LoadedConfig, type ParlorConfig } from "@parlor/config";
import type { Config } from "@tanstack/router-generator";

type RouterGenerator = typeof import("@tanstack/router-generator");

export function routeTreeFile(config: ParlorConfig): string {
  return config.web.routeTree ?? DEFAULT_ROUTE_TREE;
}

export function routesDirectory(config: ParlorConfig): string {
  return join(dirname(routeTreeFile(config)), "routes");
}

/** Shared by the Vite plugin and `parlor typegen`, so both write the same file byte for byte. */
export function routeGeneratorOptions(config: ParlorConfig, root: string) {
  return {
    target: "react",
    routesDirectory: routesDirectory(config),
    generatedRouteTree: routeTreeFile(config),
    tmpDir: resolve(root, GENERATED_DIR, "tanstack"),
    quoteStyle: "double",
    semicolons: true,
  } as const satisfies Partial<Config>;
}

/** The generator `@tanstack/router-plugin` itself depends on, so typegen and dev run one version. */
export function routerGeneratorPath(): string {
  const fromHere = createRequire(import.meta.url);
  const fromPlugin = createRequire(
    fromHere.resolve("@tanstack/router-plugin/package.json"),
  );
  const manifestPath = fromPlugin.resolve("@tanstack/router-generator/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly exports: { readonly ".": { readonly import: { readonly default: string } } };
  };
  return join(dirname(manifestPath), manifest.exports["."].import.default);
}

export async function generateRouteTree({
  config,
  rootDir,
}: LoadedConfig): Promise<void> {
  const { Generator, getConfig } = (await import(
    pathToFileURL(routerGeneratorPath()).href
  )) as RouterGenerator;
  const generator = new Generator({
    config: getConfig(routeGeneratorOptions(config, rootDir), rootDir),
    root: rootDir,
  });
  await generator.run();
}
