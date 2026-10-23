import { mkdir, readdir } from "node:fs/promises";
import { basename } from "node:path";

import { CATALOG } from "./catalog.js";
import { renderAgentsMd, renderReadme } from "./docs.js";
import { editSource, type Op } from "./edit/ops.js";
import { parseSource } from "./edit/source.js";
import { CreateError } from "./errors.js";
import { type TemplateFiles, templateFiles, writeFiles } from "./files.js";
import { type GitOutcome, initialCommit } from "./git.js";
import { type AppIdentity, identityFor } from "./identity.js";
import {
  commandsFor,
  type InstallOutcome,
  type PackageManager,
  packageManagerField,
  packageManagerFiles,
  runInstall,
} from "./package-manager.js";
import { FRAMEWORK_VERSION } from "./version.js";

export interface CreateOptions {
  readonly directory: string;
  readonly packageManager: PackageManager;
  readonly mode: "apply" | "dry-run";
  readonly install: boolean;
  readonly git: boolean;
  readonly log: (line: string) => void;
}

export interface CreatedProject {
  readonly directory: string;
  readonly identity: AppIdentity;
  readonly packageManager: PackageManager;
  readonly files: readonly string[];
  readonly install: InstallOutcome | { readonly kind: "skipped" };
  readonly git: GitOutcome | { readonly kind: "disabled" };
}

export const CREATE_SAFE_ENTRIES: ReadonlySet<string> = new Set([
  ".git",
  ".DS_Store",
  ".idea",
  ".vscode",
  ".claude",
  ".cursor",
  "LICENSE",
  "Thumbs.db",
]);

const DEFAULT_TEMPLATE = "default";

/**
 * The default template's `parlor.config.ts` names itself; create renames it through the same
 * edit engine `parlor add` uses, so the template stays a plain project with no placeholders.
 */
export function identityOps(identity: AppIdentity): readonly Op[] {
  const call = { callee: "defineConfig", from: "@parlor/config" };
  return [
    {
      kind: "set-property",
      call,
      path: ["app", "id"],
      value: JSON.stringify(identity.appId),
      onConflict: "replace",
    },
    {
      kind: "set-property",
      call,
      path: ["app", "name"],
      value: JSON.stringify(identity.appName),
      onConflict: "replace",
    },
  ];
}

const CONFIG_FILE = "parlor.config.ts";

function renameApp(text: string, identity: AppIdentity): string {
  const outcome = editSource(parseSource(CONFIG_FILE, text), identityOps(identity));
  if (outcome.status === "unsafe") {
    throw new Error(
      `The default template's ${CONFIG_FILE} cannot be renamed: ${outcome.unsafe.map((entry) => entry.reason).join(" ")}`,
    );
  }
  return outcome.status === "edit" ? outcome.text : text;
}

export async function renderProject(
  identity: AppIdentity,
  packageManager: PackageManager,
  templates: TemplateFiles,
  version: string = FRAMEWORK_VERSION,
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  for (const path of await templates.list(DEFAULT_TEMPLATE, "")) {
    const text = await templates.read(DEFAULT_TEMPLATE, path);
    files.set(
      path,
      path === "package.json"
        ? rewritePackageJson(text, identity, packageManager, version)
        : path === CONFIG_FILE
          ? renameApp(text, identity)
          : text,
    );
  }
  const docs = { identity, packageManager, version };
  files.set("README.md", renderReadme(docs));
  files.set("AGENTS.md", renderAgentsMd(docs));
  for (const [path, text] of packageManagerFiles(packageManager)) files.set(path, text);
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

interface Manifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

const UNINSTALLABLE = /^(?:workspace|catalog|link|file|portal):/;

/** `catalog:` takes the range the framework was published with, so the project resolves one zod and one React. */
export function rewritePackageJson(
  text: string,
  identity: AppIdentity,
  packageManager: PackageManager,
  version: string,
): string {
  const manifest = JSON.parse(text) as Manifest;
  const resolve = (dependencies: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        const resolved = range.startsWith("workspace:")
          ? version
          : range === "catalog:"
            ? (CATALOG[name] ?? range)
            : range;
        if (UNINSTALLABLE.test(resolved)) {
          throw new Error(
            `${name}@${range} cannot be installed outside the Parlor repo.`,
          );
        }
        return [name, resolved];
      }),
    );
  const field = packageManagerField(packageManager);
  const { name: _name, packageManager: _manager, ...rest } = manifest;
  const rewritten: Manifest = {
    name: identity.packageName,
    ...rest,
    ...(field ? { packageManager: field } : {}),
    ...(manifest.dependencies ? { dependencies: resolve(manifest.dependencies) } : {}),
    ...(manifest.devDependencies
      ? { devDependencies: resolve(manifest.devDependencies) }
      : {}),
  };
  return `${JSON.stringify(rewritten, null, 2)}\n`;
}

async function checkTarget(directory: string): Promise<void> {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const blocking = entries.filter((entry) => !CREATE_SAFE_ENTRIES.has(entry)).sort();
  if (blocking.length > 0) {
    throw new CreateError(
      `${basename(directory)} is not empty (${blocking.join(", ")}). Pick a new folder name.`,
    );
  }
}

/** Install and git failures are reported, never thrown: the files are already a working project. */
export async function createProject(options: CreateOptions): Promise<CreatedProject> {
  const { directory, packageManager } = options;
  await checkTarget(directory);
  const identity = identityFor(basename(directory));
  const files = await renderProject(identity, packageManager, templateFiles());
  const result = {
    directory,
    identity,
    packageManager,
    files: [...files.keys()],
    install: { kind: "skipped" } as CreatedProject["install"],
    git: { kind: "disabled" } as CreatedProject["git"],
  };
  if (options.mode === "dry-run") return result;
  await mkdir(directory, { recursive: true });
  await writeFiles(directory, files);
  const install = options.install
    ? await runInstall(directory, commandsFor(packageManager).install, options.log)
    : result.install;
  const git = options.git ? await initialCommit(directory) : result.git;
  return { ...result, install, git };
}
