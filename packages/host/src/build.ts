import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { UI_MANIFEST_FILE } from "@parlor/agent-ui";
import { GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import { webOutDir } from "@parlor/shell-web";
import { build, copyPublicAssets, createNitro, prepare } from "nitro/builder";
import type { NitroConfig } from "nitro/types";

import {
  hostEntrySource,
  INDEX_HTML_PLACEHOLDER,
  UI_MANIFEST_PLACEHOLDER,
} from "./entry.js";
import { type DeployPreset, syncTransportFor } from "./presets.js";

export const SYNC_TRANSPORT_ENV = "PARLOR_SYNC_TRANSPORT";
const TRACED_DEPENDENCIES = ["@electric-sql/pglite", "pg"] as const;
const DEFAULT_COMPATIBILITY_DATE =
  "2026-10-01" satisfies NitroConfig["compatibilityDate"];

export interface ServerBuildOptions {
  readonly preset: DeployPreset;
  readonly basePath?: string | undefined;
  readonly compatibilityDate?: NitroConfig["compatibilityDate"] | undefined;
}

export interface ServerBuildResult {
  readonly rootDir: string;
  readonly outputDir: string;
  readonly preset: DeployPreset;
  readonly syncTransport: "sse" | "poll";
}

export function hostRootDir(projectRoot: string): string {
  return join(projectRoot, GENERATED_DIR, "nitro");
}

export async function buildServer(
  { config, rootDir }: LoadedConfig,
  options: ServerBuildOptions,
): Promise<ServerBuildResult> {
  const hostRoot = hostRootDir(rootDir);
  const basePath = options.basePath ?? "/_parlor";
  const syncTransport = config.server.sync?.transport ?? syncTransportFor(options.preset);
  const indexHtml = await readFile(join(webOutDir(rootDir), "index.html"), "utf8").catch(
    () => "",
  );
  const uiManifest = await readFile(
    join(rootDir, GENERATED_DIR, UI_MANIFEST_FILE),
    "utf8",
  ).then(
    (text) => JSON.stringify(JSON.parse(text)),
    () => "undefined",
  );

  await mkdir(hostRoot, { recursive: true });
  const entryPath = join(hostRoot, "entry.mjs");
  await writeFile(
    entryPath,
    hostEntrySource({ serverEntry: join(rootDir, config.server.entry), basePath }),
  );
  await writeFile(join(hostRoot, ".gitignore"), "*\n");

  const nitro = await createNitro({
    rootDir: hostRoot,
    preset: options.preset,
    serverEntry: entryPath,
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    publicAssets: [{ dir: webOutDir(rootDir), baseURL: "/", fallthrough: true }],
    traceDeps: [...TRACED_DEPENDENCIES],
    replace: {
      [INDEX_HTML_PLACEHOLDER]: JSON.stringify(indexHtml),
      [UI_MANIFEST_PLACEHOLDER]: uiManifest,
      [`process.env.${SYNC_TRANSPORT_ENV}`]: JSON.stringify(syncTransport),
    },
  });
  await prepare(nitro);
  await copyPublicAssets(nitro);
  await build(nitro);
  await nitro.close();

  return {
    rootDir: hostRoot,
    outputDir: nitro.options.output.dir,
    preset: options.preset,
    syncTransport,
  };
}
