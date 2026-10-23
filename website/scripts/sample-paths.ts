import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly publishConfig?: {
    readonly exports?: Readonly<Record<string, string | { readonly types?: string }>>;
  };
}

const PACKAGES = new URL("../../packages/", import.meta.url);
const OUTPUT = new URL("../.generated/sample-paths.json", import.meta.url);

/**
 * Every published entry's declaration file, so samples compile against `dist/*.d.ts` (what an
 * app installs) instead of the workspace's `src/*.ts`. Derived from `publishConfig.exports`, so
 * a new entry needs no edit here. Absolute, because twoslash resolves \`paths\` from its own root.
 */
export function samplePaths(packagesDir: URL): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const dir of readdirSync(packagesDir)) {
    const manifest = JSON.parse(
      readFileSync(new URL(`${dir}/package.json`, packagesDir), "utf8"),
    ) as Manifest;
    if (manifest.private) continue;
    for (const [entry, target] of Object.entries(manifest.publishConfig?.exports ?? {})) {
      const types = typeof target === "string" ? undefined : target.types;
      if (!types) continue;
      const specifier =
        entry === "." ? manifest.name : `${manifest.name}/${entry.slice(2)}`;
      paths[specifier] = [fileURLToPath(new URL(`${dir}/${types}`, packagesDir))];
    }
  }
  return paths;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(new URL(".", OUTPUT), { recursive: true });
  writeFileSync(
    OUTPUT,
    `${JSON.stringify({ compilerOptions: { paths: samplePaths(PACKAGES) } }, null, 2)}\n`,
  );
}
