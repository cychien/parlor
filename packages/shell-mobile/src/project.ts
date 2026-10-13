import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_DIR, type LoadedConfig, type ParlorConfig } from "@parlor/config";

export const CAPACITOR_PLUGINS = [
  "@capacitor/app",
  "@capacitor/local-notifications",
] as const;

export interface CapacitorProjectOptions {
  readonly devUrl?: string | undefined;
}

export function capacitorProjectDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "capacitor");
}

export function capacitorConfig(
  config: ParlorConfig,
  options: CapacitorProjectOptions = {},
) {
  return {
    appId: config.app.id,
    appName: config.app.name,
    webDir: "../web",
    ios: { contentInset: "automatic" },
    ...(options.devUrl ? { server: { url: options.devUrl, cleartext: true } } : {}),
  };
}

export function capacitorProjectFiles(
  config: ParlorConfig,
  options: CapacitorProjectOptions = {},
): Record<string, string> {
  const packageJson = {
    name: `${config.app.id.replaceAll(".", "-")}-capacitor`,
    private: true,
    version: config.app.version,
    dependencies: Object.fromEntries(
      [
        "@capacitor/core",
        "@capacitor/ios",
        "@capacitor/android",
        ...CAPACITOR_PLUGINS,
      ].map((name) => [name, "*"]),
    ),
  };
  return {
    "capacitor.config.json": `${JSON.stringify(capacitorConfig(config, options), null, 2)}\n`,
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    ".gitignore": "*\n",
  };
}

function shellNodeModules(): string {
  return fileURLToPath(new URL("../node_modules/", import.meta.url));
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function ensureCapacitorProject(
  { config, rootDir }: LoadedConfig,
  options: CapacitorProjectOptions = {},
  nodeModules: string = shellNodeModules(),
): Promise<string> {
  const projectDir = capacitorProjectDir(rootDir);
  for (const [relative, content] of Object.entries(
    capacitorProjectFiles(config, options),
  )) {
    await writeIfChanged(join(projectDir, relative), content);
  }
  await symlink(nodeModules, join(projectDir, "node_modules"), "dir").catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    },
  );
  return projectDir;
}
