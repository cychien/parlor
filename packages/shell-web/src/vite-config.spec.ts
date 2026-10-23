import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LoadedConfig, parseConfig } from "@parlor/config";
import type { InlineConfig, PluginOption } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parlorWeb, type WebOptions } from "./plugin.js";
import { mergeViteConfig, parlorViteConfig } from "./vite-config.js";

const SHELLS: ReadonlyArray<readonly [string, WebOptions, InlineConfig]> = [
  ["web dev", {}, {}],
  ["web build", {}, { build: { outDir: "out", emptyOutDir: true }, logLevel: "warn" }],
  ["tauri", { conditions: ["parlor-tauri"], serverUrl: "http://localhost:3000" }, {}],
  [
    "capacitor",
    {
      conditions: ["parlor-capacitor"],
      serverUrl: "http://localhost:3000",
      cspMeta: true,
    },
    {},
  ],
];

function names(plugins: readonly PluginOption[] | undefined): string[] {
  return (plugins ?? [])
    .flat(Infinity as 1)
    .flatMap((plugin) =>
      plugin && typeof plugin === "object" && "name" in plugin ? [plugin.name] : [],
    );
}

function shape(config: InlineConfig) {
  const { plugins, ...rest } = config;
  return { ...rest, plugins: names(plugins) };
}

const marker = (): PluginOption => ({ name: "marker" });

async function project(vite?: Record<string, unknown>): Promise<LoadedConfig> {
  const rootDir = await mkdtemp(join(tmpdir(), "parlor-vite-"));
  const config = parseConfig({
    app: { id: "com.example.todo", name: "Todo" },
    ...(vite ? { vite } : {}),
  });
  return { config, rootDir, configFile: join(rootDir, "parlor.config.ts") };
}

describe("parlorViteConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the app's plugins after the framework's in every shell and warns once about root", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await project({
      plugins: [marker()],
      define: { X: "1" },
      root: "elsewhere",
    });
    for (const [, options, framework] of SHELLS) {
      const config = parlorViteConfig(loaded, options, framework);
      const frameworkNames = names(
        parlorWeb(loaded.config, { ...options, root: loaded.rootDir }),
      );
      expect(names(config.plugins)).toEqual([...frameworkNames, "marker"]);
      expect(config.define).toEqual({ X: "1" });
      expect(config.root).toBe(loaded.rootDir);
      expect(config.configFile).toBe(false);
      expect(config).toMatchObject(framework);
    }
    expect(warn.mock.calls).toEqual([
      ["vite.root in parlor.config.ts is ignored: Parlor sets it from its own config."],
    ]);
  });

  it.each(SHELLS)(
    "builds the same config as before for a project without the field for %s",
    async (_shell, options, framework) => {
      const loaded = await project();
      const base = {
        root: loaded.rootDir,
        configFile: false as const,
        plugins: parlorWeb(loaded.config, { ...options, root: loaded.rootDir }),
        ...framework,
      };
      expect(shape(parlorViteConfig(loaded, options, framework))).toEqual(shape(base));
    },
  );

  it("warns once about a vite.config file it never reads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await project();
    await writeFile(join(loaded.rootDir, "vite.config.ts"), "export default {};\n");
    parlorViteConfig(loaded, {}, {});
    parlorViteConfig(loaded, {}, {});
    expect(warn.mock.calls).toEqual([
      [
        "vite.config.ts is not read. Put Vite options in the vite field of parlor.config.ts.",
      ],
    ]);
  });
});

describe("mergeViteConfig", () => {
  it("drops every framework-owned key, merges objects and lets the framework win scalars", () => {
    const { config, ignored } = mergeViteConfig(
      {
        root: "a",
        base: "/b/",
        configFile: "c",
        build: { outDir: "d", emptyOutDir: false, sourcemap: true },
        server: { port: 1, strictPort: false, open: true },
        resolve: { conditions: ["app"] },
        define: { X: "1" },
      },
      { root: "/r", build: { outDir: "/o" }, server: { port: 5173 }, define: { Y: "2" } },
    );
    expect(ignored).toEqual([
      "root",
      "base",
      "configFile",
      "build.outDir",
      "build.emptyOutDir",
      "server.port",
      "server.strictPort",
    ]);
    expect(config).toMatchObject({
      root: "/r",
      build: { outDir: "/o", sourcemap: true },
      server: { port: 5173, open: true },
      resolve: { conditions: ["app"] },
      define: { X: "1", Y: "2" },
      plugins: [],
    });
    expect(config.base).toBeUndefined();
    expect(config.configFile).toBeUndefined();
    expect(config.build?.emptyOutDir).toBeUndefined();
    expect(config.server?.strictPort).toBeUndefined();
  });

  it("returns the framework config untouched without an app config", () => {
    const framework = { root: "/r" };
    expect(mergeViteConfig(undefined, framework)).toEqual({
      config: framework,
      ignored: [],
    });
  });
});
