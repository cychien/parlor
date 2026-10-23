import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PackageManifest, ProjectFiles } from "./add/plan.js";
import { TEMPLATES_DIR } from "./version.js";

/** npm never publishes a file named `.gitignore`, so templates store it as `_gitignore`. */
export const RENAMED_ON_COPY: Readonly<Record<string, string>> = {
  _gitignore: ".gitignore",
};

export const NEVER_COPIED: ReadonlySet<string> = new Set(["node_modules", ".parlor"]);

export interface TemplateFiles {
  list(template: string, dir: string): Promise<readonly string[]>;
  read(template: string, path: string): Promise<string>;
}

function onCopy(path: string): string {
  const name = path.split("/").pop() ?? path;
  const renamed = RENAMED_ON_COPY[name];
  return renamed ? `${path.slice(0, -name.length)}${renamed}` : path;
}

function fromCopy(path: string): string {
  const name = path.split("/").pop() ?? path;
  const original = Object.entries(RENAMED_ON_COPY).find(([, to]) => to === name)?.[0];
  return original ? `${path.slice(0, -name.length)}${original}` : path;
}

async function walk(
  root: string,
  dir: string,
  skip: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  const nested = await Promise.all(
    entries
      .filter((entry) => !skip.has(entry.name))
      .map((entry) => {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        return entry.isDirectory() ? walk(root, path, skip) : Promise.resolve([path]);
      }),
  );
  return nested.flat();
}

const readJson = (path: string) =>
  readFile(path, "utf8").then(
    (text) => JSON.parse(text) as PackageManifest,
    () => undefined,
  );

/** `manifest` reads `<rootDir>/node_modules/<name>/package.json`. */
export function projectFiles(rootDir: string): ProjectFiles {
  return {
    read: (path) => readFile(join(rootDir, path), "utf8").catch(() => undefined),
    list: async (dir) => (await walk(rootDir, dir, NEVER_LISTED)).sort(),
    manifest: (name) => readJson(join(rootDir, "node_modules", name, "package.json")),
  };
}

const NEVER_LISTED: ReadonlySet<string> = new Set(["node_modules", ".git", ".parlor"]);

export function inMemoryFiles(
  files: ReadonlyMap<string, string>,
  manifests: ReadonlyMap<string, PackageManifest> = new Map(),
): ProjectFiles {
  return {
    read: async (path) => files.get(path),
    list: async (dir) =>
      [...files.keys()].filter((path) => dir === "" || path.startsWith(`${dir}/`)).sort(),
    manifest: async (name) => manifests.get(name),
  };
}

export function templateFiles(templatesDir: string = TEMPLATES_DIR): TemplateFiles {
  return {
    list: async (template, dir) =>
      (await walk(join(templatesDir, template), dir, NEVER_COPIED)).map(onCopy).sort(),
    read: (template, path) =>
      readFile(join(templatesDir, template, fromCopy(path)), "utf8"),
  };
}

/** Temp-and-rename, so a crash leaves whole files. */
export async function writeFiles(
  rootDir: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [path, content] of files) {
    const target = join(rootDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.parlor-tmp`, content);
    await rename(`${target}.parlor-tmp`, target);
  }
}
