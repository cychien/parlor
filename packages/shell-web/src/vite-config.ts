import { existsSync } from "node:fs";
import { join } from "node:path";

import type { LoadedConfig } from "@parlor/config";
import { type InlineConfig, mergeConfig, type UserConfig } from "vite";

import { parlorWeb, type WebOptions } from "./plugin.js";

export const FRAMEWORK_VITE_KEYS = [
  "root",
  "base",
  "configFile",
  "build.outDir",
  "build.emptyOutDir",
  "server.port",
  "server.strictPort",
] as const;

export const STRAY_VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
] as const;

export interface MergedViteConfig {
  readonly config: InlineConfig;
  readonly ignored: readonly string[];
}

/** The framework wins every scalar it sets, so the proxy, conditions and defines Parlor needs survive. */
export function mergeViteConfig(
  user: UserConfig | undefined,
  framework: InlineConfig,
): MergedViteConfig {
  if (!user) return { config: framework, ignored: [] };
  const { plugins: userPlugins = [], ...userRest } = user;
  const own: Record<string, unknown> = { ...userRest };
  const ignored: string[] = [];
  for (const key of FRAMEWORK_VITE_KEYS) {
    const [head = "", leaf] = key.split(".");
    if (leaf === undefined) {
      if (head in own) ignored.push(key);
      delete own[head];
      continue;
    }
    const section = own[head];
    if (typeof section !== "object" || section === null || !(leaf in section)) continue;
    const { [leaf]: _dropped, ...rest } = section as Record<string, unknown>;
    own[head] = rest;
    ignored.push(key);
  }
  const { plugins: frameworkPlugins = [], ...frameworkRest } = framework;
  const merged = mergeConfig(own, frameworkRest) as InlineConfig;
  return {
    config: { ...merged, plugins: [...frameworkPlugins, ...userPlugins] },
    ignored,
  };
}

export function strayViteConfig(rootDir: string): string | undefined {
  return STRAY_VITE_CONFIGS.find((name) => existsSync(join(rootDir, name)));
}

const warned = new Set<string>();

function warnOnce(messages: readonly string[]): void {
  for (const message of messages) {
    if (warned.has(message)) continue;
    warned.add(message);
    console.warn(message);
  }
}

export function parlorViteConfig(
  { config, rootDir }: LoadedConfig,
  options: WebOptions,
  framework: InlineConfig,
): InlineConfig {
  const { config: merged, ignored } = mergeViteConfig(config.vite, {
    ...framework,
    root: rootDir,
    configFile: false,
    plugins: parlorWeb(config, { ...options, root: rootDir }),
  });
  warnOnce(
    ignored.map(
      (key) =>
        `vite.${key} in parlor.config.ts is ignored: Parlor sets it from its own config.`,
    ),
  );
  const stray = strayViteConfig(rootDir);
  if (stray) {
    warnOnce([
      `${stray} is not read. Put Vite options in the vite field of parlor.config.ts.`,
    ]);
  }
  return merged;
}
