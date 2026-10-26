import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { pagePattern, UI_MANIFEST_FILE, type UiManifest } from "@parlor/agent-ui";
import {
  appServerEnv,
  ConfigError,
  generatedDir,
  type LoadedConfig,
  type ParlorConfig,
} from "@parlor/config";
import { appCsp, extendCsp, serializeCsp, webOutDir } from "@parlor/shell-web";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { build, copyPublicAssets, createNitro, prepare } from "nitro/builder";
import type { NitroConfig } from "nitro/types";

import {
  importRequiredBuiltins,
  keepJsonOutOfChunkGroups,
  labelChunkGroups,
} from "./bundle.js";
import {
  cloudflareEntrySource,
  DURABLE_SERVER_BINDING,
  DURABLE_SERVER_CLASS,
  durableServerSource,
  hostEntrySource,
  INDEX_HTML_PLACEHOLDER,
  NONCE_PLACEHOLDER,
  PAGE_ROUTES_PLACEHOLDER,
  type RenderEntryOptions,
  UI_MANIFEST_PLACEHOLDER,
} from "./entry.js";
import {
  type DeployPreset,
  nitroPresetFor,
  runsOnWorkerd,
  syncTransportFor,
} from "./presets.js";

export const SYNC_TRANSPORT_ENV = "PARLOR_SYNC_TRANSPORT";
export const MIGRATIONS_PLACEHOLDER = "__PARLOR_MIGRATIONS__";
const TRACED_DEPENDENCIES = ["@electric-sql/pglite", "pg"] as const;
const DEFAULT_COMPATIBILITY_DATE =
  "2026-10-01" satisfies NitroConfig["compatibilityDate"];

export interface ServerBuildOptions {
  readonly preset: DeployPreset;
  readonly basePath?: string | undefined;
  readonly compatibilityDate?: NitroConfig["compatibilityDate"] | undefined;
  /** The server render module `buildRender` wrote, for an app with `web.ssr`. */
  readonly render?: string | undefined;
}

export interface ServerBuildResult {
  readonly rootDir: string;
  readonly outputDir: string;
  readonly preset: DeployPreset;
  readonly syncTransport: "sse" | "poll";
}

export function hostRootDir(projectRoot: string): string {
  return join(generatedDir(projectRoot), "nitro");
}

function pageRoutesSource(manifest: Pick<UiManifest, "routes"> | undefined): string {
  return `[${(manifest?.routes ?? []).map((route) => String(pagePattern(route.path))).join(", ")}]`;
}

/**
 * The entry sets the policy on the documents it serves itself, so these cover only the static
 * files: a rule matching every path would also override the app's own responses.
 */
async function staticFileRules(
  webDir: string,
  headers: Record<string, string>,
  ignored: readonly string[],
): Promise<NonNullable<NitroConfig["routeRules"]>> {
  const entries = await readdir(webDir, { withFileTypes: true }).catch(() => []);
  const rules: NonNullable<NitroConfig["routeRules"]> = {};
  for (const entry of entries) {
    if (ignored.includes(entry.name)) continue;
    rules[entry.isDirectory() ? `/${entry.name}/**` : `/${entry.name}`] = { headers };
    if (entry.name === "index.html") rules["/"] = { headers };
  }
  return rules;
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
  const manifest = await readFile(
    join(generatedDir(rootDir), UI_MANIFEST_FILE),
    "utf8",
  ).then(
    (text) => JSON.parse(text) as UiManifest,
    () => undefined,
  );
  const policy = appCsp(config, {});
  const contentSecurityPolicy = serializeCsp(policy);
  const render: RenderEntryOptions | undefined = options.render
    ? {
        module: options.render,
        contentSecurityPolicy: serializeCsp(
          extendCsp(policy, { "script-src": [`'nonce-${NONCE_PLACEHOLDER}'`] }),
        ),
      }
    : undefined;

  // With server rendering, every document goes through the entry, `/` included.
  const ignoredAssets = render ? ["index.html"] : [];

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
          contentSecurityPolicy,
          render,
          locationHint: config.deploy.cloudflare?.locationHint,
        })
      : hostEntrySource({ serverEntry, basePath, contentSecurityPolicy, render }),
  );
  await writeFile(join(hostRoot, ".gitignore"), "*\n");

  const nitro = await createNitro({
    rootDir: hostRoot,
    preset: nitroPresetFor(options.preset),
    serverEntry: entryPath,
    ...(cloudflare ? { cloudflare: cloudflare.nitro } : {}),
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    publicAssets: [
      {
        dir: webOutDir(rootDir),
        baseURL: "/",
        fallthrough: true,
        ...(render
          ? { ignore: ignoredAssets.map((name) => join(webOutDir(rootDir), name)) }
          : {}),
      },
    ],
    routeRules: await staticFileRules(
      webOutDir(rootDir),
      { "content-security-policy": contentSecurityPolicy },
      ignoredAssets,
    ),
    traceDeps: [...TRACED_DEPENDENCIES],
    hooks: {
      "rollup:before": (nitroBuild, bundle) => {
        keepJsonOutOfChunkGroups(bundle);
        labelChunkGroups(bundle);
        if (runsOnWorkerd(options.preset)) importRequiredBuiltins(nitroBuild, bundle);
      },
    },
    replace: {
      [INDEX_HTML_PLACEHOLDER]: JSON.stringify(indexHtml),
      [UI_MANIFEST_PLACEHOLDER]: manifest ? JSON.stringify(manifest) : "undefined",
      [PAGE_ROUTES_PLACEHOLDER]: pageRoutesSource(manifest),
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

/**
 * Wrangler applies Durable Object migrations as an append-only log, after the last tag a
 * deployment applied. An app with its own migrations lists ours where it first deployed.
 */
export function withServerMigration(
  migrations: NonNullable<WranglerConfig["migrations"]>,
): NonNullable<WranglerConfig["migrations"]> {
  const declared = migrations.some((migration) =>
    [migration.new_classes, migration.new_sqlite_classes].some((classes) =>
      classes?.includes(DURABLE_SERVER_CLASS),
    ),
  );
  if (declared) return migrations;
  return [
    ...migrations,
    { tag: "parlor-server-v1", new_sqlite_classes: [DURABLE_SERVER_CLASS] },
  ];
}

function durableWranglerConfig(config: ParlorConfig): WranglerConfig {
  const own = (config.deploy.cloudflare?.wrangler ?? {}) as WranglerConfig;
  return {
    name: workerName(config.app.id),
    ...own,
    durable_objects: {
      bindings: [
        { name: DURABLE_SERVER_BINDING, class_name: DURABLE_SERVER_CLASS },
        ...(own.durable_objects?.bindings ?? []),
      ],
    },
    migrations: withServerMigration(own.migrations ?? []),
  };
}

export interface UnavailableDurableObject {
  readonly binding: string;
  readonly className: string;
}

export interface DevWranglerConfig {
  readonly wrangler: WranglerConfig;
  /** Classes the Worker itself would define: no Worker code runs in development. */
  readonly unavailable: readonly UnavailableDurableObject[];
}

/** The bindings a cloudflare-durable build declares, as Wrangler's `getPlatformProxy()` reads them. */
export function devWranglerConfig(
  config: ParlorConfig,
  compatibilityDate: string = DEFAULT_COMPATIBILITY_DATE,
): DevWranglerConfig {
  const {
    main: _main,
    assets: _assets,
    migrations: _migrations,
    durable_objects: durableObjects,
    ...production
  } = durableWranglerConfig(config);
  const bindings = durableObjects?.bindings ?? [];
  const ownClass = (binding: (typeof bindings)[number]) =>
    !binding.script_name || binding.script_name === production.name;
  return {
    wrangler: {
      ...production,
      compatibility_date: production.compatibility_date ?? compatibilityDate,
      compatibility_flags: [
        ...new Set([...(production.compatibility_flags ?? []), "nodejs_compat"]),
      ],
      durable_objects: { bindings: bindings.filter((binding) => !ownClass(binding)) },
    },
    unavailable: bindings
      .filter(ownClass)
      .map((binding) => ({ binding: binding.name, className: binding.class_name })),
  };
}

async function prepareDurable(
  { config, rootDir }: Pick<LoadedConfig, "config" | "rootDir">,
  hostRoot: string,
  serverEntry: string,
): Promise<DurableBuild> {
  const workerExports = config.deploy.cloudflare?.exports;
  const workerExportsPath = workerExports ? join(rootDir, workerExports) : undefined;
  if (workerExportsPath && !existsSync(workerExportsPath)) {
    throw new ConfigError(
      `deploy.cloudflare.exports names ${workerExports}, which does not exist in ${rootDir}`,
    );
  }
  const exportsPath = join(hostRoot, "exports.cloudflare.mjs");
  await writeFile(
    exportsPath,
    durableServerSource({
      serverEntry,
      connectionScopes: installed(rootDir, "@parlor/data"),
      workerExports: workerExportsPath,
    }),
  );
  return {
    migrations: embeddedMigrations(rootDir, config.database.migrations),
    nitro: {
      exports: exportsPath,
      deployConfig: true,
      nodeCompat: true,
      wrangler: durableWranglerConfig(config),
    },
  };
}

/**
 * The CLI of the nitro this package builds with, for `nitro deploy`. Nitro ships it as a
 * `bin`, not an export, so it is found through nitro's own manifest.
 */
export function nitroCli(): string {
  const manifest = createRequire(import.meta.url).resolve("nitro/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
    readonly bin?: string | Readonly<Record<string, string>>;
  };
  const entry = typeof bin === "string" ? bin : bin?.nitro;
  if (!entry) throw new Error(`${manifest} names no nitro CLI.`);
  return join(dirname(manifest), entry);
}
