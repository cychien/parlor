import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

export function templateFiles(templatesDir: string = TEMPLATES_DIR): TemplateFiles {
  const walk = async (root: string, dir: string): Promise<string[]> => {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    const nested = await Promise.all(
      entries
        .filter((entry) => !NEVER_COPIED.has(entry.name))
        .map((entry) => {
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          return entry.isDirectory() ? walk(root, path) : Promise.resolve([path]);
        }),
    );
    return nested.flat();
  };
  return {
    list: async (template, dir) =>
      (await walk(join(templatesDir, template), dir)).map(onCopy).sort(),
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
