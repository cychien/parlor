import { isBuiltin } from "node:module";

import type { Nitro, NitroHooks } from "nitro/types";

type BundleConfig = Parameters<NitroHooks["rollup:before"]>[1];

type ChunkTest = RegExp | ((id: string) => boolean | null | undefined);

interface ChunkGroup {
  test?: ChunkTest;
}

const JSON_MODULE = /\.json(?:\?|$)/;
const REQUIRED_BUILTIN = "\0parlor:required:";

function matches(test: ChunkTest | undefined, id: string): boolean {
  if (test === undefined) return true;
  return typeof test === "function" ? Boolean(test(id)) : test.test(id);
}

function chunkGroups(config: BundleConfig): ChunkGroup[] {
  const splitting: unknown = (config.output as { codeSplitting?: unknown } | undefined)
    ?.codeSplitting;
  if (typeof splitting !== "object" || splitting === null) return [];
  const { groups } = splitting as { groups?: unknown };
  return Array.isArray(groups) ? (groups as ChunkGroup[]) : [];
}

/**
 * Rolldown lists a JSON module's keys among the exports of the shared chunk it groups the
 * module into, without defining them, when the module is imported lazily and the bundle has
 * top-level await. The chunk then fails to load, so JSON stays out of Nitro's library chunks.
 */
export function keepJsonOutOfChunkGroups(config: BundleConfig): void {
  for (const group of chunkGroups(config)) {
    const { test } = group;
    group.test = (id) => !JSON_MODULE.test(id) && matches(test, id);
  }
}

/** The Node built-ins the runtime provides itself, which the bundle leaves to it. */
function nativeBuiltins(nitro: Nitro): Set<string> {
  return new Set(
    nitro.options.unenv.flatMap((preset) => preset.external ?? []).filter(isBuiltin),
  );
}

/**
 * workerd's `require` cannot load every built-in its `import` can, `node:process` among them,
 * so a dependency's CommonJS `require` of a built-in becomes an import of it, as Wrangler's own
 * bundler does.
 */
export function importRequiredBuiltins(nitro: Nitro, config: BundleConfig): void {
  const native = nativeBuiltins(nitro);
  const builtin = (id: string) =>
    native.has(id) ? id : native.has(`node:${id}`) ? `node:${id}` : undefined;
  if (Array.isArray(config.external)) {
    config.external = config.external.filter(
      (id) => typeof id !== "string" || builtin(id) === undefined,
    );
  }
  config.plugins = [
    {
      name: "parlor:import-required-builtins",
      resolveId: {
        order: "pre",
        handler(id: string, _importer: string | undefined, { kind }: { kind?: string }) {
          const name = builtin(id);
          if (name === undefined) return undefined;
          return kind === "require-call"
            ? `${REQUIRED_BUILTIN}${name}`
            : { id, external: true };
        },
      },
      load(id: string) {
        if (!id.startsWith(REQUIRED_BUILTIN)) return undefined;
        const name = JSON.stringify(id.slice(REQUIRED_BUILTIN.length));
        return `import builtin from ${name};\nmodule.exports = builtin;\n`;
      },
    },
    ...(config.plugins ?? []),
  ];
}
