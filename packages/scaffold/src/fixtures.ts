import { fileURLToPath } from "node:url";

import type { ProjectLayout } from "./add/addon.js";
import { type PackageManifest, planAddons } from "./add/plan.js";
import { ADDONS } from "./addons/index.js";
import { inMemoryFiles, type TemplateFiles } from "./files.js";

/**
 * `fixtures/with-auth` is the default template after `parlor add auth`, checked in as a
 * workspace package so CI typechecks and tests the composed project. `scripts/write-fixtures.ts`
 * rewrites it from the engine; `fixtures.spec.ts` fails when the two differ, so it is never
 * synced by hand.
 */
export const FIXTURES_DIR: string = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);

export const WITH_AUTH = {
  dir: "with-auth",
  packageName: "parlor-fixture-with-auth",
  addons: ["auth"],
} as const;

/** The default layout, which both the template and the fixture use. */
export const DEFAULT_LAYOUT: Omit<ProjectLayout, "rootDir"> = {
  serverEntry: "server.ts",
  schemaDir: "schema",
  migrationsDir: "migrations",
  routeTree: "src/routeTree.gen.ts",
};

/**
 * The fixture's files before its generators run: the default template with `_gitignore` kept
 * under its template name, the plan's writes laid over it, and `package.json` as the package
 * manager would leave it, except that `"framework"` dependencies are `workspace:*` so the
 * fixture installs inside the repo. `authManifest` stands in for the installed `@parlor/auth`,
 * which is how `better-auth` gets its pin.
 */
export async function composeWithAuth(
  templates: TemplateFiles,
  authManifest: PackageManifest,
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  for (const path of await templates.list("default", "")) {
    files.set(path, await templates.read("default", path));
  }
  const plan = await planAddons(
    { ...DEFAULT_LAYOUT, rootDir: "/" },
    WITH_AUTH.addons,
    inMemoryFiles(files, new Map([["@parlor/auth", authManifest]])),
    templates,
  );
  if (plan.kind !== "ready") {
    throw new Error(
      `The default template no longer takes ${WITH_AUTH.addons.join(", ")}: ${plan.kind}`,
    );
  }
  for (const write of plan.writes) files.set(write.path, write.content);
  const manifest = JSON.parse(files.get("package.json") ?? "{}") as PackageManifest &
    Record<string, unknown>;
  const declared = WITH_AUTH.addons.flatMap((name) =>
    Object.entries(ADDONS[name].dependencies),
  );
  const dependencies: Record<string, string> = { ...manifest.dependencies };
  for (const dependency of plan.dependencies) {
    const version = declared.find(([name]) => name === dependency.name)?.[1];
    dependencies[dependency.name] =
      version === "framework" ? "workspace:*" : String(dependency.version);
  }
  files.set(
    "package.json",
    `${JSON.stringify(
      {
        ...manifest,
        name: WITH_AUTH.packageName,
        dependencies: Object.fromEntries(
          Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
      null,
      2,
    )}\n`,
  );
  const ignore = files.get(".gitignore");
  files.delete(".gitignore");
  if (ignore !== undefined) files.set("_gitignore", ignore);
  return files;
}

/** Paths the fixture holds that the composition does not: written by the generators. */
export function isGeneratedPath(path: string): boolean {
  return (
    path === DEFAULT_LAYOUT.routeTree ||
    path.startsWith(`${DEFAULT_LAYOUT.migrationsDir}/`)
  );
}
