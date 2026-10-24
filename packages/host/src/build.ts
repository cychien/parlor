import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { UI_MANIFEST_FILE } from "@parlor/agent-ui";
import { appServerEnv, GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import { appCsp, serializeCsp, webOutDir } from "@parlor/shell-web";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { build, copyPublicAssets, createNitro, prepare } from "nitro/builder";
import type { NitroConfig } from "nitro/types";

import {
  cloudflareEntrySource,
  DURABLE_SERVER_BINDING,
  DURABLE_SERVER_CLASS,
  durableServerSource,
  hostEntrySource,
  INDEX_HTML_PLACEHOLDER,
  UI_MANIFEST_PLACEHOLDER,
} from "./entry.js";
import { type DeployPreset, nitroPresetFor, syncTransportFor } from "./presets.js";

export const SYNC_TRANSPORT_ENV = "PARLOR_SYNC_TRANSPORT";
export const MIGRATIONS_PLACEHOLDER = "__PARLOR_MIGRATIONS__";
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
  const serverEntry = join(rootDir, config.server.entry);
  const entryPath = join(hostRoot, "entry.mjs");
  const cloudflare =
    options.preset === "cloudflare-durable"
      ? await prepareDurable({ config, rootDir }, hostRoot, serverEntry)
      : undefined;
  await writeFile(
    entryPath,
    cloudflare
      ? cloudflareEntrySource({
          basePath,
          locationHint: config.deploy.cloudflare?.locationHint,
        })
      : hostEntrySource({ serverEntry, basePath }),
  );
  await writeFile(join(hostRoot, ".gitignore"), "*\n");

  const nitro = await createNitro({
    rootDir: hostRoot,
    preset: nitroPresetFor(options.preset),
    serverEntry: entryPath,
    ...(cloudflare ? { cloudflare: cloudflare.nitro } : {}),
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    publicAssets: [{ dir: webOutDir(rootDir), baseURL: "/", fallthrough: true }],
    routeRules: {
      "/**": { headers: { "content-security-policy": serializeCsp(appCsp(config, {})) } },
      [`${basePath}/**`]: { headers: false },
    },
    traceDeps: [...TRACED_DEPENDENCIES],
    replace: {
      [INDEX_HTML_PLACEHOLDER]: JSON.stringify(indexHtml),
      [UI_MANIFEST_PLACEHOLDER]: uiManifest,
      [`process.env.${SYNC_TRANSPORT_ENV}`]: JSON.stringify(syncTransport),
      ...(cloudflare ? { [MIGRATIONS_PLACEHOLDER]: cloudflare.migrations } : {}),
      ...Object.fromEntries(
        Object.entries(appServerEnv(config)).map(([name, value]) => [
          `process.env.${name}`,
          JSON.stringify(value),
        ]),
      ),
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

type CloudflareOptions = NonNullable<NitroConfig["cloudflare"]>;
type WranglerConfig = NonNullable<CloudflareOptions["wrangler"]>;

interface DurableBuild {
  readonly nitro: CloudflareOptions;
  readonly migrations: string;
}

/** `app.id` is reverse-DNS lowercase alphanumerics, so only its dots need replacing. */
function workerName(appId: string): string {
  return appId.replaceAll(".", "-").slice(0, 63);
}

function embeddedMigrations(rootDir: string, folder: string): string {
  const absolute = join(rootDir, folder);
  if (!existsSync(join(absolute, "meta", "_journal.json"))) return "undefined";
  return JSON.stringify({ [folder]: readMigrationFiles({ migrationsFolder: absolute }) });
}

/** The bundler's view: a node_modules lookup from the project, never NODE_PATH. */
function installed(rootDir: string, name: string): boolean {
  for (let dir = rootDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

async function prepareDurable(
  { config, rootDir }: Pick<LoadedConfig, "config" | "rootDir">,
  hostRoot: string,
  serverEntry: string,
): Promise<DurableBuild> {
  const exportsPath = join(hostRoot, "exports.cloudflare.mjs");
  await writeFile(
    exportsPath,
    durableServerSource({
      serverEntry,
      connectionScopes: installed(rootDir, "@parlor/data"),
    }),
  );
  const own = (config.deploy.cloudflare?.wrangler ?? {}) as WranglerConfig;
  return {
    migrations: embeddedMigrations(rootDir, config.database.migrations),
    nitro: {
      exports: exportsPath,
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: workerName(config.app.id),
        ...own,
        durable_objects: {
          bindings: [
            { name: DURABLE_SERVER_BINDING, class_name: DURABLE_SERVER_CLASS },
            ...(own.durable_objects?.bindings ?? []),
          ],
        },
        migrations: [
          { tag: "parlor-server-v1", new_sqlite_classes: [DURABLE_SERVER_CLASS] },
          ...(own.migrations ?? []),
        ],
      },
    },
  };
}
