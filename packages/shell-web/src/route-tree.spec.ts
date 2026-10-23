import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type LoadedConfig, parseConfig } from "@parlor/config";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { parlorWeb } from "./plugin.js";
import { generateRouteTree, routerGeneratorPath } from "./route-tree.js";

const ROOT_ROUTE = `import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({ component: Outlet });
`;

const page = (path: string) => `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("${path}")({ component: () => null });
`;

async function project(): Promise<LoadedConfig> {
  const rootDir = await mkdtemp(join(tmpdir(), "parlor-routes-"));
  await mkdir(join(rootDir, "src", "routes"), { recursive: true });
  await writeFile(join(rootDir, "src", "routes", "__root.tsx"), ROOT_ROUTE);
  await writeFile(join(rootDir, "src", "routes", "index.tsx"), page("/"));
  await writeFile(join(rootDir, "src", "routes", "about.tsx"), page("/about"));
  const config = parseConfig({ app: { id: "com.example.todo", name: "Todo" } });
  return { config, rootDir, configFile: join(rootDir, "parlor.config.ts") };
}

async function generateWithVite({ config, rootDir }: LoadedConfig): Promise<void> {
  const server = await createServer({
    root: rootDir,
    configFile: false,
    logLevel: "silent",
    plugins: parlorWeb(config, { root: rootDir }),
    server: { port: 0, strictPort: false, watch: null },
  });
  await server.close();
}

describe("generateRouteTree", () => {
  it("writes the same route tree as the Vite plugin, before any dev run", async () => {
    const loaded = await project();
    const tree = join(loaded.rootDir, "src", "routeTree.gen.ts");
    expect(existsSync(tree)).toBe(false);

    await generateRouteTree(loaded);
    const fromTypegen = await readFile(tree, "utf8");
    expect(fromTypegen).toContain(`"/about"`);

    await rm(tree);
    await generateWithVite(loaded);
    expect(await readFile(tree, "utf8")).toBe(fromTypegen);
  }, 30_000);

  it("loads the generator version @tanstack/router-plugin depends on", async () => {
    const pluginManifest = createRequire(import.meta.url).resolve(
      "@tanstack/router-plugin/package.json",
    );
    const plugin = JSON.parse(await readFile(pluginManifest, "utf8")) as {
      dependencies: Record<string, string>;
    };
    const generatorManifest = createRequire(pluginManifest).resolve(
      "@tanstack/router-generator/package.json",
    );
    const generator = JSON.parse(await readFile(generatorManifest, "utf8")) as {
      version: string;
    };
    expect(generator.version).toBe(plugin.dependencies["@tanstack/router-generator"]);
    expect(routerGeneratorPath()).toBe(
      join(dirname(generatorManifest), "dist", "esm", "index.js"),
    );
  });
});
