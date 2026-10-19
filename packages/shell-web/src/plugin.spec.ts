import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

import { parlorWeb, webManifest } from "./plugin.js";

const config = parseConfig({
  app: { id: "com.example.todo", name: "Todo", description: "A todo app" },
  server: { port: 3100 },
  web: { port: 5200 },
});

describe("parlorWeb", () => {
  it("proxies framework routes to the configured server port", async () => {
    const resolved = await resolveConfig(
      { configFile: false, plugins: parlorWeb(config) },
      "serve",
    );
    expect(resolved.server.port).toBe(5200);
    expect(resolved.server.strictPort).toBe(true);
    expect(resolved.server.proxy).toEqual({
      "/_parlor": "http://localhost:3100",
      "/.well-known/oauth-protected-resource": "http://localhost:3100",
      "/.well-known/oauth-authorization-server": "http://localhost:3100",
    });
  });

  it("registers the PWA plugin only when enabled", async () => {
    const withPwa = await resolveConfig(
      { configFile: false, plugins: parlorWeb(config) },
      "build",
    );
    const withoutPwa = await resolveConfig(
      {
        configFile: false,
        plugins: parlorWeb({ ...config, web: { ...config.web, pwa: false } }),
      },
      "build",
    );
    const names = (c: typeof withPwa) => c.plugins.map((p) => p.name);
    expect(names(withPwa).some((n) => n.startsWith("vite-plugin-pwa"))).toBe(true);
    expect(names(withoutPwa).some((n) => n.startsWith("vite-plugin-pwa"))).toBe(false);
  });

  it("derives the web manifest from app config", () => {
    expect(webManifest(config)).toEqual({
      id: "com.example.todo",
      name: "Todo",
      short_name: "Todo",
      description: "A todo app",
      start_url: "/",
      display: "standalone",
      theme_color: "#ffffff",
      background_color: "#ffffff",
    });
  });
});

describe("resolve conditions", () => {
  it("appends shell conditions after Vite's defaults", async () => {
    const resolved = await resolveConfig(
      { configFile: false, plugins: parlorWeb(config, { conditions: ["parlor-tauri"] }) },
      "build",
    );
    expect(resolved.resolve.conditions.at(-1)).toBe("parlor-tauri");
    expect(resolved.resolve.conditions).toContain("browser");
  });
});

describe("server url", () => {
  it("injects the shell server url for the action client, empty for same-origin web", async () => {
    const withUrl = await resolveConfig(
      {
        configFile: false,
        plugins: parlorWeb(config, { serverUrl: "https://api.test" }),
      },
      "build",
    );
    const without = await resolveConfig(
      { configFile: false, plugins: parlorWeb(config) },
      "build",
    );
    expect(withUrl.define?.["import.meta.env.PARLOR_SERVER_URL"]).toBe(
      '"https://api.test"',
    );
    expect(without.define?.["import.meta.env.PARLOR_SERVER_URL"]).toBe('""');
  });
});

describe("file routes", () => {
  const routerPlugins = async (root: string, web = config.web) => {
    const resolved = await resolveConfig(
      { root, configFile: false, plugins: parlorWeb({ ...config, web }, { root }) },
      "build",
    );
    return resolved.plugins.map((p) => p.name).filter((n) => n.startsWith("tanstack:"));
  };

  it("adds the TanStack Router generator only when the routes directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "parlor-routes-"));
    expect(await routerPlugins(root)).toEqual([]);
    await mkdir(join(root, "src", "routes"), { recursive: true });
    expect(await routerPlugins(root)).toContain("tanstack:router-generator");
  });

  it("looks for routes next to a configured route tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "parlor-routes-"));
    await mkdir(join(root, "app", "routes"), { recursive: true });
    const web = { ...config.web, routeTree: "app/routeTree.gen.ts" };
    expect(await routerPlugins(root, web)).toContain("tanstack:router-generator");
  });

  it("generates the route tree from src/routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "parlor-routes-"));
    await mkdir(join(root, "src", "routes"), { recursive: true });
    await writeFile(
      join(root, "src", "routes", "__root.tsx"),
      'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute({});\n',
    );
    await writeFile(
      join(root, "src", "routes", "settings.tsx"),
      'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/settings")({});\n',
    );
    await resolveConfig(
      { root, configFile: false, plugins: parlorWeb(config, { root }) },
      "build",
    );
    const tree = await readFile(join(root, "src", "routeTree.gen.ts"), "utf8");
    expect(tree).toContain('path: "/settings"');
  });
});
