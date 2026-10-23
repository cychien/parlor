import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { projectFiles } from "../files.js";
import {
  type Command,
  commandsFor,
  formatCommand,
  type InstallOutcome,
  type PackageManager,
  runInstall,
} from "../package-manager.js";
import type { Generation, ProjectLayout } from "./addon.js";
import {
  generationDone,
  type PlannedDependency,
  type PlannedWrite,
  type ProjectFiles,
  resolveFromPackage,
} from "./plan.js";
import type { AddTools } from "./run.js";

/** Under `.parlor/`, which every project ignores, so a crash leaves nothing a commit would pick up. */
export const STAGING_DIR = ".parlor/add";

/** Never copied into a staging dir and never committed back from one. */
export const NOT_STAGED: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".parlor",
]);

/** `package.json` plus whichever lockfile the project has, as they were before the install. */
export interface ManifestSnapshot {
  readonly files: ReadonlyMap<string, Buffer | undefined>;
}

export const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export async function snapshotManifests(rootDir: string): Promise<ManifestSnapshot> {
  const files = new Map<string, Buffer | undefined>();
  for (const name of ["package.json", ...LOCKFILES]) {
    files.set(name, await readFile(join(rootDir, name)).catch(() => undefined));
  }
  return { files };
}

/** Puts every snapshotted file back, deleting the ones that did not exist. */
export async function restoreManifests(
  rootDir: string,
  snapshot: ManifestSnapshot,
): Promise<void> {
  for (const [name, content] of snapshot.files) {
    const path = join(rootDir, name);
    if (content === undefined) await rm(path, { force: true });
    else await writeFile(path, content);
  }
}

export type InstallResult =
  | { readonly ok: true; readonly outcome: InstallOutcome }
  | { readonly ok: false; readonly message: string };

/**
 * Two rounds of `<pm> add`, because a `FromPackage` version is readable only once that package
 * is in `node_modules`: round one adds every dependency with a known version, round two reads
 * each `FromPackage` through `project.manifest` and adds those. A `listed` dependency with no
 * known version is a plain `<pm> install`. Nothing here touches files other than the ones the
 * package manager owns.
 */
export async function installDependencies(
  rootDir: string,
  dependencies: readonly PlannedDependency[],
  manager: PackageManager,
  project: ProjectFiles,
  log: (line: string) => void,
): Promise<InstallResult> {
  const add = commandsFor(manager).add;
  let outcome: InstallOutcome = { kind: "installed" };
  const round = async (
    resolved: readonly (PlannedDependency & { readonly version: string })[],
  ): Promise<InstallResult | undefined> => {
    for (const dev of [false, true]) {
      const group = resolved.filter((dependency) => dependency.dev === dev);
      if (group.length === 0) continue;
      const command = add(
        group.map((dependency) => `${dependency.name}@${dependency.version}`),
        { dev },
      );
      const result = await runInstall(rootDir, command, log);
      if (result.kind === "failed") {
        return {
          ok: false,
          message: `${formatCommand(command)} failed (exit ${result.exitCode}).`,
        };
      }
      if (result.kind === "ignored-builds") outcome = result;
    }
    return undefined;
  };
  const known = dependencies.filter(
    (dependency): dependency is PlannedDependency & { readonly version: string } =>
      typeof dependency.version === "string",
  );
  if (known.length > 0) {
    log(
      `installing ${known.map((dependency) => `${dependency.name}@${dependency.version}`).join(", ")}`,
    );
    const failed = await round(known);
    if (failed) return failed;
  }
  const pinned: (PlannedDependency & { readonly version: string })[] = [];
  for (const dependency of dependencies) {
    if (typeof dependency.version === "string") continue;
    const version = await resolveFromPackage(dependency.version, project);
    if (version === undefined) {
      return {
        ok: false,
        message: `${dependency.version.fromPackage} does not declare ${dependency.version.dependency}`,
      };
    }
    log(
      `installing ${dependency.name}@${version} (pinned by ${dependency.version.fromPackage})`,
    );
    pinned.push({ ...dependency, version });
  }
  const failed = await round(pinned);
  return failed ?? { ok: true, outcome };
}

/** The install commands `--no-install` left for the developer, in the order to run them. */
export function pendingInstallCommands(
  dependencies: readonly PlannedDependency[],
  manager: PackageManager,
): readonly Command[] {
  const add = commandsFor(manager).add;
  return [false, true].flatMap((dev) => {
    const group = dependencies.filter(
      (dependency) => dependency.dev === dev && typeof dependency.version === "string",
    );
    return group.length === 0
      ? []
      : [
          add(
            group.map((dependency) => `${dependency.name}@${String(dependency.version)}`),
            { dev },
          ),
        ];
  });
}

export interface Staging {
  /** Absolute: `<rootDir>/.parlor/add/<run id>`. */
  readonly dir: string;
  /** A `ProjectFiles` over `dir`, for `generationDone` and the commit diff. */
  readonly files: ProjectFiles;
}

/**
 * Copies the project tree except `NOT_STAGED` into a fresh staging dir and lays `writes` over
 * it. Module resolution from the staging dir walks up to the project's `node_modules`, so the
 * generators run there unchanged.
 */
export async function stageProject(
  rootDir: string,
  writes: readonly PlannedWrite[],
): Promise<Staging> {
  const dir = join(rootDir, STAGING_DIR, randomUUID());
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(rootDir)) {
    if (NOT_STAGED.has(entry)) continue;
    await cp(join(rootDir, entry), join(dir, entry), { recursive: true });
  }
  for (const write of writes) {
    const target = join(dir, write.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, write.content);
  }
  return { dir, files: projectFiles(dir) };
}

export type GenerateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly generation: Generation; readonly message: string };

/**
 * Runs each generation's tool in the staging dir, then checks `generationDone` there. A tool
 * that throws, or whose declared outputs are not in the copy afterwards, fails the whole run
 * before anything reaches the project.
 */
export async function generateInStaging(
  layout: ProjectLayout,
  staging: Staging,
  generations: readonly Generation[],
  tools: AddTools,
): Promise<GenerateResult> {
  for (const generation of generations) {
    const tool =
      generation.kind === "route-tree" ? "parlor typegen" : "parlor db generate";
    try {
      if (generation.kind === "route-tree") await tools.routeTree(staging.dir);
      else await tools.migration(staging.dir, generation.name);
    } catch (error) {
      return {
        ok: false,
        generation,
        message: `${tool} failed: ${(error as Error).message}`,
      };
    }
    if (
      !(await generationDone(
        { ...layout, rootDir: staging.dir },
        generation,
        staging.files,
      ))
    ) {
      return {
        ok: false,
        generation,
        message:
          generation.kind === "route-tree"
            ? `${tool} wrote no route ${generation.routes.join(", ")}`
            : `${tool} wrote no migration with tables ${generation.tables.join(", ")}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Every file in the staging dir whose bytes differ from the project's is written through
 * `<path>.parlor-tmp` and a rename, then the staging dir is removed. Returns the project paths
 * written. A crash between two renames leaves whole files, and the next run's plan finds each
 * written step `done`.
 */
export async function commitStaging(
  rootDir: string,
  staging: Staging,
): Promise<readonly string[]> {
  const written: string[] = [];
  for (const path of await staging.files.list("")) {
    const staged = await readFile(join(staging.dir, path));
    const current = await readFile(join(rootDir, path)).catch(() => undefined);
    if (current?.equals(staged)) continue;
    const target = join(rootDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.parlor-tmp`, staged);
    await rename(`${target}.parlor-tmp`, target);
    written.push(path);
  }
  await discardStaging(staging);
  return written;
}

export async function discardStaging(staging: Staging): Promise<void> {
  await rm(staging.dir, { recursive: true, force: true });
}
