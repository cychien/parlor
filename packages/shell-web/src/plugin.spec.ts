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
