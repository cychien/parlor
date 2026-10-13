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
    expect(resolved.server.proxy).toEqual({ "/_parlor": "http://localhost:3100" });
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
  it("injects server.url for the action client, empty when unset", async () => {
    const withUrl = await resolveConfig(
      {
        configFile: false,
        plugins: parlorWeb({
          ...config,
          server: { ...config.server, url: "https://api.test" },
        }),
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
