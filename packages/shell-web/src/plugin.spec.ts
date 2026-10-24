import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { createServer, resolveConfig, build } from "vite";
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
    expect(without.define?.["import.meta.env.PARLOR_APP_ORIGIN"]).toBe('""');
  });

  it("injects the app origin parlor dev names for a target next to the web one", async () => {
    const injected = await resolveConfig(
      {
        configFile: false,
        plugins: parlorWeb(config, { appOrigin: "http://localhost:5174" }),
      },
      "serve",
    );
    expect(injected.define?.["import.meta.env.PARLOR_APP_ORIGIN"]).toBe(
      '"http://localhost:5174"',
    );
  });

  it("injects app.scheme, which a native shell's social sign-in returns to", async () => {
    const withScheme = await resolveConfig(
      {
        configFile: false,
        plugins: parlorWeb(parseConfig({ app: { ...config.app, scheme: "todo" } })),
      },
      "build",
    );
    const without = await resolveConfig(
      { configFile: false, plugins: parlorWeb(config) },
      "build",
    );
    expect(withScheme.define?.["import.meta.env.PARLOR_APP_SCHEME"]).toBe('"todo"');
    expect(without.define?.["import.meta.env.PARLOR_APP_SCHEME"]).toBe('""');
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port assigned")),
      );
    });
  });
}

async function emptyApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "parlor-csp-"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.ts"></script></body></html>',
  );
  await writeFile(join(root, "main.ts"), "export {};");
  return root;
}

describe("content security policy", () => {
  it("serves the dev policy on pages and leaves framework routes to their own", async () => {
    const root = await emptyApp();
    const port = await freePort();
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: parlorWeb(
        {
          ...config,
          web: {
            ...config.web,
            port,
            pwa: false,
            csp: { "img-src": ["https://cdn.test"] },
          },
        },
        { root, serverUrl: "http://localhost:3100" },
      ),
    });
    await server.listen();
    try {
      const page = await fetch(`http://localhost:${port}/`);
      expect(page.headers.get("content-security-policy")).toBe(
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https://cdn.test",
          "font-src 'self'",
          "connect-src 'self' http://localhost:3100 ws:",
          "worker-src 'self'",
          "manifest-src 'self'",
          "frame-src 'none'",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join("; "),
      );
      const framework = await fetch(`http://localhost:${port}/_parlor/ping`);
      expect(framework.headers.get("content-security-policy")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("writes the build policy as a meta tag only when the shell asks, without frame-ancestors", async () => {
    const built = async (cspMeta: boolean) => {
      const root = await emptyApp();
      const outDir = join(root, "out");
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: parlorWeb(
          { ...config, web: { ...config.web, pwa: false } },
          { root, serverUrl: "https://api.test", cspMeta },
        ),
        build: { outDir },
      });
      return readFile(join(outDir, "index.html"), "utf8");
    };
    const withMeta = await built(true);
    const policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://api.test",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    expect(withMeta).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll("'", "&#39;")}">`,
    );
    expect(await built(false)).not.toContain("Content-Security-Policy");
  }, 30_000);
});
