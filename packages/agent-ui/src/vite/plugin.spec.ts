import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build, createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentManifest } from "./plugin.js";

const app = { id: "dev.parlor.fixture", name: "Fixture" };
const packageRoot = new URL("../..", import.meta.url).pathname;
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function routeTree(settingsDescription: string, secondTask = false) {
  return `
import { createRootRoute, createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { defineAgentView } from "../../src/view.ts";

const task = defineAgentView({ name: "task", description: "A task.", keyed: true, schema: z.object({ title: z.string() }) });
const other = ${secondTask ? 'defineAgentView({ name: "task", description: "Another.", schema: z.object({}) })' : "task"};
const root = createRootRoute();
const home = createRoute({ getParentRoute: () => root, path: "/", staticData: { description: "Home.", views: [task] } });
const settings = createRoute({ getParentRoute: () => root, path: "/settings", staticData: { description: ${JSON.stringify(settingsDescription)}, views: [other] } });
const bare = createRoute({ getParentRoute: () => root, path: "/bare" });
export const routeTree = root.addChildren([home, settings, bare]);
`;
}

async function fixture(settingsDescription: string, secondTask = false) {
  const root = await mkdtemp(join(packageRoot, ".fixture-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "routeTree.gen.ts"),
    routeTree(settingsDescription, secondTask),
  );
  await writeFile(join(root, "index.html"), "<!doctype html><title>x</title>");
  return root;
}

const loggerWith = (warn: (message: string) => void) => ({
  info: () => {},
  warn,
  warnOnce: () => {},
  error: () => {},
  clearScreen: () => {},
  hasErrorLogged: () => false,
  hasWarned: false,
});

const manifestOf = async (root: string) =>
  JSON.parse(await readFile(join(root, ".parlor", "ui-manifest.json"), "utf8"));

describe("agentManifest", () => {
  it("writes the manifest from the route tree when building and warns about undescribed pages", async () => {
    const root = await fixture("Settings.");
    const warn = vi.fn();
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      customLogger: loggerWith(warn),
      plugins: [agentManifest({ app })],
      build: { outDir: join(root, "dist"), write: false },
    });
    const manifest = await manifestOf(root);
    expect(manifest.routes.map((r: { path: string }) => r.path)).toEqual([
      "/",
      "/settings",
      "/bare",
    ]);
    expect(manifest.views.map((v: { name: string }) => v.name)).toEqual(["task"]);
    expect(warn).toHaveBeenCalledWith(
      '[parlor] Route "/bare" has no staticData.description.',
    );
  }, 30_000);

  it("writes the manifest into the generated directory it is given", async () => {
    const root = await fixture("Settings.");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [agentManifest({ app, generatedDir: ".parlor/e2e" })],
      build: { outDir: join(root, "dist"), write: false },
    });
    const written = JSON.parse(
      await readFile(join(root, ".parlor", "e2e", "ui-manifest.json"), "utf8"),
    );
    expect(written.routes.map((r: { path: string }) => r.path)).toContain("/settings");
    await expect(stat(join(root, ".parlor", "ui-manifest.json"))).rejects.toThrow();
  }, 30_000);

  it("writes the manifest when route modules import stylesheets, which Node never needs", async () => {
    const root = await fixture("Settings.");
    await writeFile(join(root, "src", "app.css"), "body { color: red; }\n");
    await writeFile(join(root, "src", "card.module.css"), ".card { color: blue; }\n");
    await writeFile(
      join(root, "src", "routeTree.gen.ts"),
      `import "./app.css";\nimport card from "./card.module.css";\nvoid card;\n${routeTree("Settings.")}`,
    );
    const warn = vi.fn();
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      customLogger: loggerWith(warn),
      plugins: [agentManifest({ app })],
      build: { outDir: join(root, "dist"), write: false },
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Building without the agent UI manifest"),
    );
    expect((await manifestOf(root)).routes).toHaveLength(3);
  }, 30_000);

  it("writes the manifest when route modules import through the app's resolve.alias", async () => {
    const root = await fixture("Settings.");
    await mkdir(join(root, "shared"), { recursive: true });
    await writeFile(join(root, "shared", "copy.ts"), 'export const HOME = "Home.";\n');
    await writeFile(
      join(root, "src", "routeTree.gen.ts"),
      `import { HOME } from "@shared/copy";\nvoid HOME;\n${routeTree("Settings.")}`,
    );
    const warn = vi.fn();
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      customLogger: loggerWith(warn),
      resolve: { alias: { "@shared": join(root, "shared") } },
      plugins: [agentManifest({ app })],
      build: { outDir: join(root, "dist"), write: false },
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Building without the agent UI manifest"),
    );
    expect((await manifestOf(root)).routes).toHaveLength(3);
  }, 30_000);

  it("fails the build when two different views share a name", async () => {
    const root = await fixture("Settings.", true);
    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [agentManifest({ app })],
        build: { outDir: join(root, "dist"), write: false },
      }),
    ).rejects.toThrow('Two different agent views are named "task".');
  }, 30_000);

  it("builds without a manifest and names the module when a route module touches a browser global at import", async () => {
    const root = await fixture("Settings.");
    await mkdir(join(root, "src", "routes"), { recursive: true });
    await writeFile(
      join(root, "src", "routes", "theme.ts"),
      'export const theme = localStorage.getItem("theme");\n',
    );
    await writeFile(
      join(root, "src", "routeTree.gen.ts"),
      `import "./routes/theme.ts";\n${routeTree("Settings.")}`,
    );
    await mkdir(join(root, ".parlor"), { recursive: true });
    await writeFile(join(root, ".parlor", "ui-manifest.json"), '{"stale":true}\n');
    const warn = vi.fn();
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      customLogger: loggerWith(warn),
      plugins: [agentManifest({ app })],
      build: { outDir: join(root, "dist"), write: false },
    });
    expect(warn).toHaveBeenCalledWith(
      '[parlor] Building without the agent UI manifest: src/routes/theme.ts threw "ReferenceError: localStorage is not defined" while the route tree was loaded in Node. Keep browser-only code out of the top level of route modules.',
    );
    await expect(stat(join(root, ".parlor", "ui-manifest.json"))).rejects.toThrow();
  }, 30_000);

  it("regenerates in dev after a route file changes, without touching unchanged output", async () => {
    const root = await fixture("Settings.");
    const server: ViteDevServer = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { port: 0, ws: false },
      plugins: [agentManifest({ app })],
    });
    cleanups.push(() => server.close());
    await server.listen();
    const file = join(root, ".parlor", "ui-manifest.json");
    await vi.waitFor(
      async () => expect((await manifestOf(root)).routes).toHaveLength(3),
      {
        timeout: 10_000,
      },
    );
    const firstWrite = (await stat(file)).mtimeMs;

    await writeFile(
      join(root, "src", "routeTree.gen.ts"),
      routeTree("Account and app settings."),
    );
    const saved = Date.now();
    await vi.waitFor(
      async () =>
        expect((await manifestOf(root)).routes[1].description).toBe(
          "Account and app settings.",
        ),
      { timeout: 5000, interval: 10 },
    );
    expect(Date.now() - saved).toBeLessThan(1000);
    expect((await stat(file)).mtimeMs).toBeGreaterThan(firstWrite);
  }, 30_000);
});
