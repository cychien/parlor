import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type AliasOptions,
  build as viteBuild,
  isRunnableDevEnvironment,
  type Logger,
  type Plugin,
  type Rolldown,
  runnerImport,
  type ViteDevServer,
} from "vite";

import {
  type ManifestBuild,
  type UiAppInfo,
  UI_MANIFEST_FILE,
  type UiManifest,
} from "../manifest.js";
import { buildUiManifest } from "./manifest.js";

export const DEFAULT_ROUTE_TREE = "src/routeTree.gen.ts";
const GENERATED_DIR = ".parlor";
const REGENERATE_DEBOUNCE_MS = 50;

export interface AgentManifestOptions {
  readonly app: UiAppInfo;
  readonly routeTree?: string | undefined;
  /** Where the manifest is written, absolute or relative to the root. Defaults to `.parlor`. */
  readonly generatedDir?: string | undefined;
}

export function manifestFromModule(app: UiAppInfo, module: unknown): ManifestBuild {
  return buildUiManifest(app, (module as { routeTree?: unknown } | undefined)?.routeTree);
}

const STYLE_IMPORT = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:\?|$)/;
const EMPTY_STYLE = "\0parlor-empty-style";

/**
 * The manifest needs route modules, never their stylesheets, and Vite's CSS plugin cannot
 * run outside a build (8.3.5 throws), so every style import loads as an empty module.
 */
function withoutStyles(): Plugin {
  return {
    name: "parlor:manifest-without-styles",
    enforce: "pre",
    resolveId: (source) => (STYLE_IMPORT.test(source) ? EMPTY_STYLE : undefined),
    load: (id) => (id === EMPTY_STYLE ? "export default {};" : undefined),
  };
}

/**
 * Imports the route tree as one tree-shaken bundle of it and its dependencies, so Node loads
 * one module instead of every file of every library the routes import.
 */
async function importBundled(
  entry: string,
  root: string,
  alias: AliasOptions,
  outDir: string,
): Promise<unknown> {
  const built = (await viteBuild({
    root,
    configFile: false,
    logLevel: "silent",
    publicDir: false,
    resolve: { alias },
    plugins: [withoutStyles()],
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      write: false,
      minify: false,
      copyPublicDir: false,
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })) as Rolldown.RolldownOutput;
  const chunk = built.output.find(
    (output): output is Rolldown.OutputChunk => output.type === "chunk" && output.isEntry,
  );
  if (!chunk) throw new Error(`Bundling ${entry} produced no entry chunk.`);
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `route-tree.${process.pid}.${Date.now()}.mjs`);
  await writeFile(file, chunk.code);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(file, { force: true });
  }
}

const STACK_FILE = /(?:\(|at )((?:file:\/\/)?\/[^\s()]+?):\d+:\d+\)?$/;

function throwingFile(error: unknown): string | undefined {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  for (const line of stack.split("\n")) {
    const file = STACK_FILE.exec(line.trim())?.[1];
    if (file) return file.startsWith("file:") ? fileURLToPath(file) : file;
  }
  return undefined;
}

function routeTreeImportFailure(root: string, routeTree: string, error: unknown): string {
  const file = throwingFile(error);
  const module = relative(root, file && isAbsolute(file) ? file : routeTree);
  const thrown =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `${module} threw "${thrown}" while the route tree was loaded in Node`;
}

type RouteTreeLoad =
  | { readonly ok: true; readonly module: unknown }
  | { readonly ok: false; readonly failure: string };

export interface AgentManifestApi {
  /** The manifest last generated, until the route tree fails to load. */
  manifest(): UiManifest | undefined;
}

export function agentManifest(options: AgentManifestOptions): Plugin<AgentManifestApi> {
  let root = process.cwd();
  let logger: Logger | undefined;
  let lastWritten: string | undefined;
  let current: UiManifest | undefined;

  const routeTreePath = () => resolve(root, options.routeTree ?? DEFAULT_ROUTE_TREE);
  const generatedDir = () => resolve(root, options.generatedDir ?? GENERATED_DIR);
  const outFile = () => join(generatedDir(), UI_MANIFEST_FILE);

  const write = async (build: ManifestBuild) => {
    current = build.manifest;
    for (const warning of build.warnings) logger?.warn(`[parlor] ${warning}`);
    const json = `${JSON.stringify(build.manifest, null, 2)}\n`;
    lastWritten ??= await readFile(outFile(), "utf8").catch(() => undefined);
    if (json === lastWritten) return;
    await mkdir(dirname(outFile()), { recursive: true });
    const partial = `${outFile()}.${process.pid}.tmp`;
    await writeFile(partial, json);
    await rename(partial, outFile());
    lastWritten = json;
  };

  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  const loadRouteTree = async (
    load: (entry: string) => Promise<unknown>,
  ): Promise<RouteTreeLoad> => {
    const entry = routeTreePath();
    try {
      return { ok: true, module: (await exists(entry)) ? await load(entry) : undefined };
    } catch (error) {
      return { ok: false, failure: routeTreeImportFailure(root, entry, error) };
    }
  };

  const watchInDev = (server: ViteDevServer) => {
    const environment = server.environments.ssr;
    if (!environment || !isRunnableDevEnvironment(environment)) return;
    const runner = environment.runner;
    const generated = generatedDir() + sep;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();

    const generate = () => {
      running = running.then(async () => {
        try {
          runner.clearCache();
          const loaded = await loadRouteTree((entry) => runner.import(entry));
          if (!loaded.ok) {
            logger?.error(
              `[parlor] Could not generate the agent UI manifest: ${loaded.failure}.`,
            );
            return;
          }
          await write(manifestFromModule(options.app, loaded.module));
        } catch (error) {
          logger?.error(
            `[parlor] Could not generate the agent UI manifest: ${(error as Error).message}`,
          );
        }
      });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(generate, REGENERATE_DEBOUNCE_MS);
    };
    const onFile = (file: string) => {
      if (file.startsWith(generated)) return;
      if (file === routeTreePath() || runner.evaluatedModules.getModulesByFile(file)) {
        schedule();
      }
    };
    server.watcher.on("change", onFile);
    server.watcher.on("add", onFile);
    server.watcher.on("unlink", onFile);

    if (server.httpServer) server.httpServer.once("listening", generate);
    else generate();
  };

  return {
    name: "parlor:agent-manifest",
    api: { manifest: () => current },
    configResolved(config) {
      root = config.root;
      logger = config.logger;
    },
    configureServer(server) {
      watchInDev(server);
    },
    async buildStart() {
      if (this.environment.mode !== "build" || this.environment.name !== "client") return;
      const { alias } = this.environment.config.resolve;
      const loaded = await loadRouteTree(async (entry) => {
        try {
          return await importBundled(entry, root, alias, dirname(outFile()));
        } catch {
          // The runner loads module by module, so its failure names the module that threw.
          return (
            await runnerImport(entry, {
              root,
              configFile: false,
              logLevel: "error",
              resolve: { alias },
              plugins: [withoutStyles()],
            })
          ).module;
        }
      });
      if (!loaded.ok) {
        logger?.warn(
          `[parlor] Building without the agent UI manifest: ${loaded.failure}. Keep browser-only code out of the top level of route modules.`,
        );
        await rm(outFile(), { force: true });
        lastWritten = undefined;
        current = undefined;
        return;
      }
      await write(manifestFromModule(options.app, loaded.module));
    },
  };
}
