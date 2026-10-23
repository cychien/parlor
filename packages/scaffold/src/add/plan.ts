import { dirname, relative } from "node:path";

import { ADDONS, type AddonName } from "../addons/index.js";
import {
  editSource,
  evaluateOp,
  manualCode,
  type Op,
  opSummary,
  type UnsafeOp,
} from "../edit/ops.js";
import { parseSource } from "../edit/source.js";
import { importedName } from "../edit/syntax.js";
import type { TemplateFiles } from "../files.js";
import { FRAMEWORK_VERSION } from "../version.js";
import {
  type Addon,
  type DependencyVersion,
  type FromPackage,
  type Generation,
  type Mount,
  type ProjectLayout,
  SERVER_ENTRY,
} from "./addon.js";

/** The fields of a `package.json` the engine reads. */
export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** Reads the project as it is on disk; tests pass an in-memory map. */
export interface ProjectFiles {
  read(path: string): Promise<string | undefined>;
  /** Project-relative paths of every file under `dir`, recursively, skipping `node_modules`. */
  list(dir: string): Promise<readonly string[]>;
  /** The manifest of `name` as installed in the project's `node_modules`; `undefined` when absent. */
  manifest(name: string): Promise<PackageManifest | undefined>;
}

export interface PlannedWrite {
  readonly path: string;
  readonly content: string;
  readonly change: "create" | "update";
  /** One short line per op or payload, for the printed plan: "auth: createAuth(database)". */
  readonly summary: readonly string[];
}

/**
 * A dependency the package manager adds; it owns `package.json` and the lockfile, so neither
 * is a planned write. `version` stays a `FromPackage` until that package is installed, which is
 * why install runs in two rounds.
 */
export interface PlannedDependency {
  readonly name: string;
  readonly version: string | FromPackage;
  readonly dev: boolean;
}

/** What to change by hand, for D4: the file, why the tool would not, and the exact change. */
export interface ManualChange {
  readonly file: string;
  readonly reason: string;
  readonly change: string;
}

export type AddPlan =
  | { readonly kind: "done"; readonly addons: readonly AddonName[] }
  /** Nothing may be written: the developer makes `manual` by hand and runs the command again. */
  | {
      readonly kind: "blocked";
      readonly addons: readonly AddonName[];
      readonly manual: readonly ManualChange[];
    }
  | {
      readonly kind: "ready";
      readonly addons: readonly AddonName[];
      /** Every changed file with its whole new content; nothing is written while planning. */
      readonly writes: readonly PlannedWrite[];
      readonly dependencies: readonly PlannedDependency[];
      readonly generate: readonly Generation[];
      readonly notes: readonly string[];
    };

/** `fromPackage`'s own pin of `dependency`, as the project has it installed. */
export async function resolveFromPackage(
  version: FromPackage,
  project: ProjectFiles,
): Promise<string | undefined> {
  const manifest = await project.manifest(version.fromPackage);
  return (
    manifest?.dependencies?.[version.dependency] ??
    manifest?.devDependencies?.[version.dependency]
  );
}

const relativeImport = (from: string, module: string): string => {
  const path = relative(dirname(from), module).replace(/\.tsx?$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
};

const isModule = (path: string) => /\.(?:ts|tsx)$/.test(path) && !path.endsWith(".d.ts");

interface Draft {
  content: string;
  readonly change: "create" | "update";
  readonly summary: string[];
}

/**
 * Pure apart from reads. For every add-on, in order, each step is `done`, an edit, or unsafe;
 * any unsafe step makes the plan `blocked` with every manual change, not just the first.
 */
export async function planAddons(
  layout: ProjectLayout,
  addons: readonly AddonName[],
  project: ProjectFiles,
  templates: TemplateFiles,
): Promise<AddPlan> {
  const drafts = new Map<string, Draft>();
  const manual: ManualChange[] = [];
  const dependencies: PlannedDependency[] = [];
  const generate: Generation[] = [];
  const notes: string[] = [];
  const read = async (path: string) =>
    drafts.get(path)?.content ?? (await project.read(path));
  const write = async (path: string, content: string, summary: readonly string[]) => {
    const draft = drafts.get(path);
    if (draft) {
      draft.content = content;
      draft.summary.push(...summary);
      return;
    }
    const exists = (await project.read(path)) !== undefined;
    drafts.set(path, {
      content,
      change: exists ? "update" : "create",
      summary: [...summary],
    });
  };
  const manifest = JSON.parse(
    (await project.read("package.json")) ?? "{}",
  ) as PackageManifest;
  const fingerprint = () =>
    JSON.stringify([
      [...drafts].map(([path, draft]) => [path, draft.content]),
      dependencies,
      generate,
    ]);
  const listed = (name: string) =>
    Boolean(manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]);

  for (const name of addons) {
    const addon: Addon = ADDONS[name];
    const before = fingerprint();

    const requirement = unmetRequirement(name, addon, layout);
    if (requirement) {
      manual.push(requirement);
      continue;
    }

    for (const payload of addon.files) {
      for (const path of await templates.list(payload.template, payload.dir)) {
        if ((await read(path)) === undefined) {
          await write(path, await templates.read(payload.template, path), []);
        }
      }
    }

    const edits = new Map<string, Op[]>();
    const addEdit = (file: string, ops: readonly Op[]) =>
      edits.set(file, [...(edits.get(file) ?? []), ...ops]);
    for (const fileEdit of addon.edits) {
      addEdit(
        fileEdit.file === SERVER_ENTRY ? layout.serverEntry : fileEdit.file,
        fileEdit.ops,
      );
    }
    for (const mount of addon.mounts) {
      if (await mounted(mount, project, drafts)) continue;
      addEdit(mount.into.file, [
        {
          kind: "import",
          names: [mount.component],
          from: relativeImport(mount.into.file, mount.module),
        },
        { kind: "jsx-child", component: mount.into.parent, element: mount.component },
      ]);
    }
    for (const [file, ops] of edits) {
      const text = await read(file);
      if (text === undefined) {
        manual.push({
          file,
          reason: `${file} is missing.`,
          change: ops.map((op) => manualCode(op)).join("\n\n"),
        });
        continue;
      }
      const source = parseSource(file, text);
      const outcome = editSource(source, ops);
      if (outcome.status === "done") continue;
      if (outcome.status === "unsafe") {
        manual.push(manualFor(file, ops, outcome.unsafe));
        continue;
      }
      const summary = ops
        .filter((op) => evaluateOp(source, op).status === "edit")
        .map((op) => opSummary(source, op))
        .filter((line): line is string => line !== undefined);
      await write(file, outcome.text, summary);
    }

    if (addon.env.length > 0) {
      const current = (await read(ENV_EXAMPLE)) ?? "";
      const missing = addon.env.filter(
        (variable) => !new RegExp(`^${variable.name}=`, "m").test(current),
      );
      if (missing.length > 0) {
        const lines = missing.map(
          (variable) =>
            `# ${variable.description}\n${variable.name}=${variable.example}\n`,
        );
        const separator =
          current === "" || current.endsWith("\n\n")
            ? ""
            : current.endsWith("\n")
              ? "\n"
              : "\n\n";
        await write(
          ENV_EXAMPLE,
          `${current}${separator}${lines.join("\n")}`,
          missing.map((variable) => variable.name),
        );
      }
    }

    for (const [dependency, version] of Object.entries(addon.dependencies)) {
      if (dependencies.some((planned) => planned.name === dependency)) continue;
      if (listed(dependency)) continue;
      dependencies.push({
        name: dependency,
        version: await resolveVersion(version, project),
        dev: false,
      });
    }

    for (const generation of addon.generate) {
      if (!(await generationDone(layout, generation, project))) generate.push(generation);
    }

    if (fingerprint() !== before) notes.push(...addon.notes);
  }

  if (manual.length > 0) return { kind: "blocked", addons, manual };
  if (drafts.size === 0 && dependencies.length === 0 && generate.length === 0) {
    return { kind: "done", addons };
  }
  return {
    kind: "ready",
    addons,
    writes: [...drafts].map(([path, draft]) => ({ path, ...draft })),
    dependencies,
    generate,
    notes,
  };
}

const ENV_EXAMPLE = ".env.example";

function unmetRequirement(
  name: AddonName,
  addon: Addon,
  layout: ProjectLayout,
): ManualChange | undefined {
  const { requires } = addon;
  if (requires.serverAtRoot && layout.serverEntry.includes("/")) {
    return {
      file: layout.serverEntry,
      reason: `${name} needs the server entry at the project root, and it is ${layout.serverEntry}.`,
      change: `Move ${layout.serverEntry} to server.ts and set server.entry to "server.ts" in parlor.config.ts.`,
    };
  }
  if (requires.schemaDir && layout.schemaDir !== requires.schemaDir) {
    return {
      file: "parlor.config.ts",
      reason: `${name} needs the schema in ${requires.schemaDir}/, and it is in ${layout.schemaDir}.`,
      change: `Set database.schema to "${requires.schemaDir}" in parlor.config.ts and move the tables there.`,
    };
  }
  const routes = `${dirname(layout.routeTree)}/routes`;
  if (requires.routesDir && routes !== requires.routesDir) {
    return {
      file: "parlor.config.ts",
      reason: `${name} needs the routes in ${requires.routesDir}/, and they are in ${routes}/.`,
      change: `Keep web.routeTree at its default so the routes live in ${requires.routesDir}/.`,
    };
  }
  return undefined;
}

async function mounted(
  mount: Mount,
  project: ProjectFiles,
  drafts: ReadonlyMap<string, { readonly content: string }>,
): Promise<boolean> {
  const paths = new Set([
    ...(await project.list("src")),
    ...[...drafts.keys()].filter((path) => path.startsWith("src/")),
  ]);
  for (const path of paths) {
    if (!isModule(path) || path === mount.module) continue;
    const text = drafts.get(path)?.content ?? (await project.read(path));
    if (text === undefined || !text.includes(mount.component)) continue;
    const source = parseSource(path, text);
    if (importedName(source, mount.component, relativeImport(path, mount.module)))
      return true;
  }
  return false;
}

function manualFor(
  file: string,
  ops: readonly Op[],
  failed: readonly UnsafeOp[],
): ManualChange {
  const imports = ops.filter((op) => op.kind === "import").map((op) => manualCode(op));
  const changes = failed
    .filter((entry) => entry.op.kind !== "import")
    .map((entry) => manualCode(entry.op));
  return {
    file,
    reason: [...new Set(failed.map((entry) => entry.reason))].join(" "),
    change: [...(imports.length > 0 ? [imports.join("\n")] : []), ...changes].join(
      "\n\n",
    ),
  };
}

async function resolveVersion(
  version: DependencyVersion,
  project: ProjectFiles,
): Promise<string | FromPackage> {
  if (version === "framework") return FRAMEWORK_VERSION;
  if (typeof version === "string") return version;
  return (await resolveFromPackage(version, project)) ?? version;
}

/**
 * Whether a generation's declared outputs are in `project`: the route tree lists every route
 * id; the latest drizzle snapshot (the last entry of `meta/_journal.json`) has every table.
 */
export async function generationDone(
  layout: ProjectLayout,
  generation: Generation,
  project: ProjectFiles,
): Promise<boolean> {
  if (generation.kind === "route-tree") {
    const tree = await project.read(layout.routeTree);
    return (
      tree !== undefined &&
      generation.routes.every((route) => tree.includes(`"${route}"`))
    );
  }
  const journal = await project.read(`${layout.migrationsDir}/meta/_journal.json`);
  if (journal === undefined) return false;
  const entries = (JSON.parse(journal) as { entries?: { idx: number }[] }).entries ?? [];
  const last = entries.at(-1);
  if (!last) return false;
  const snapshot = await project.read(
    `${layout.migrationsDir}/meta/${String(last.idx).padStart(4, "0")}_snapshot.json`,
  );
  if (snapshot === undefined) return false;
  const tables = Object.values(
    (JSON.parse(snapshot) as { tables?: Record<string, { name: string }> }).tables ?? {},
  ).map((table) => table.name);
  return generation.tables.every((table) => tables.includes(table));
}
