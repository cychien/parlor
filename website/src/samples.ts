import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExpressiveCodePlugin } from "@astrojs/starlight/expressive-code";
import ecTwoSlash from "expressive-code-twoslash";
import ts from "typescript";

/** The compiler options every sample compiles with, on the site and in the READMEs. */
export const SAMPLES_TSCONFIG = fileURLToPath(
  new URL("../tsconfig.samples.json", import.meta.url),
);

const PACKAGES = new URL("../../packages/", import.meta.url);

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly publishConfig?: {
    readonly exports?: Readonly<Record<string, string | { readonly types?: string }>>;
  };
}

/**
 * Every published entry's declaration file, so samples compile against `dist/*.d.ts` (what an
 * app installs) instead of the workspace's `src/*.ts`. Derived from `publishConfig.exports`, so
 * a new entry needs no edit here. A package whose declarations are not all built resolves to
 * its source as a whole: mixing the two would load its modules twice, and an augmentation
 * such as `Register` would reach only one copy. Absolute, because twoslash resolves `paths`
 * from its own root.
 */
export function samplePaths(packagesDir: URL = PACKAGES): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const dir of readdirSync(packagesDir)) {
    const manifest = JSON.parse(
      readFileSync(new URL(`${dir}/package.json`, packagesDir), "utf8"),
    ) as Manifest;
    if (manifest.private) continue;
    const entries = Object.entries(manifest.publishConfig?.exports ?? {}).flatMap(
      ([entry, target]) => {
        const types = typeof target === "string" ? undefined : target.types;
        if (!types) return [];
        const specifier =
          entry === "." ? manifest.name : `${manifest.name}/${entry.slice(2)}`;
        return [
          [specifier, fileURLToPath(new URL(`${dir}/${types}`, packagesDir))] as const,
        ];
      },
    );
    if (!entries.every(([, file]) => existsSync(file))) continue;
    for (const [specifier, file] of entries) paths[specifier] = [file];
  }
  return paths;
}

/**
 * Read with the TypeScript 6 API, because expressive-code-twoslash 0.6.1 ignores its own
 * `tsConfigPath` and only applies `twoslashOptions.compilerOptions`. The paths are read from
 * the packages each time, so they always match what is built.
 */
export function samplesCompilerOptions(packagesDir: URL = PACKAGES): ts.CompilerOptions {
  const { config, error } = ts.readConfigFile(SAMPLES_TSCONFIG, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(SAMPLES_TSCONFIG));
  return { ...parsed.options, paths: samplePaths(packagesDir) };
}

/** Every `ts` and `tsx` fence compiles at build; an unannotated type error fails it (D6). */
export function typecheckedSamples(): ExpressiveCodePlugin {
  const plugin = ecTwoSlash({
    instanceConfigs: {
      twoslash: { explicitTrigger: /(?:)/, languages: ["ts", "tsx"] },
    },
    // Dependencies' JSDoc carries Markdown headings that would land in the page's table of contents.
    includeJsDoc: false,
    twoslashOptions: { compilerOptions: samplesCompilerOptions() },
  });
  // Built against Expressive Code 0.41 while Starlight ships 0.44; the plugin works with both.
  return plugin as unknown as ExpressiveCodePlugin;
}
