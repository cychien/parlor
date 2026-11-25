import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { pagePattern } from "@parlor/agent-ui";
import { agentManifest, DEFAULT_ROUTE_TREE } from "@parlor/agent-ui/vite";
import { GENERATED_DIR, generatedDir, type ParlorConfig } from "@parlor/config";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { appCsp, serializeCsp } from "./csp.js";
import { routeGeneratorOptions, routesDirectory, routeTreeFile } from "./route-tree.js";
import { pageMatcher, serverRoutes } from "./server-routes.js";
import { serviceWorkerRegistration } from "./service-worker.js";
import { renderModule } from "./ssr.js";

export const FRAMEWORK_ROUTE_PREFIX = "/_parlor";
/** OAuth discovery lives at the origin root (RFC 8414, RFC 9728), outside the framework prefix. */
export const OAUTH_DISCOVERY_PREFIXES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
] as const;
export { DEFAULT_ROUTE_TREE };

export interface WebOptions {
  readonly root?: string | undefined;
  /** Builds the server render module (`web.ssr`) instead of the browser app. */
  readonly render?: boolean | undefined;
}

function isFrameworkPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return [FRAMEWORK_ROUTE_PREFIX, ...OAUTH_DISCOVERY_PREFIXES].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function cspPlugin(config: ParlorConfig): PluginOption {
  return {
    name: "parlor:csp",
    configureServer(server) {
      const header = serializeCsp(appCsp(config, { dev: true }));
      server.middlewares.use((request, response, next) => {
        if (!isFrameworkPath(request.url)) {
          response.setHeader("content-security-policy", header);
        }
        next();
      });
    },
  };
}

/** The language the app's `index.html` declares on `<html lang>`, which its manifest then shares. */
export function documentLang(root: string): string | undefined {
  const page = resolve(root, "index.html");
  if (!existsSync(page)) return undefined;
  return /<html\b[^>]*\blang=["']([^"']+)["']/i.exec(readFileSync(page, "utf8"))?.[1];
}

export function webManifest(config: ParlorConfig, lang?: string) {
  return {
    id: config.app.id,
    name: config.app.name,
    short_name: config.app.name,
    ...(config.app.description ? { description: config.app.description } : {}),
    start_url: "/",
    display: "standalone" as const,
    theme_color: config.web.themeColor,
    background_color: config.web.backgroundColor,
    ...(lang ? { lang } : {}),
    ...(config.web.icons
      ? {
          icons: config.web.icons.map(({ src, sizes, type, purpose }) => ({
            src,
            sizes,
            ...(type ? { type } : {}),
            ...(purpose ? { purpose } : {}),
          })),
        }
      : {}),
  };
}

function fileRoutes(config: ParlorConfig, root: string): PluginOption[] {
  if (!existsSync(resolve(root, routesDirectory(config)))) return [];
  return [
    tanstackRouter({ ...routeGeneratorOptions(config, root), autoCodeSplitting: true }),
  ];
}

function titlePlugin(config: ParlorConfig): PluginOption {
  return {
    name: "parlor:title",
    transformIndexHtml(html) {
      if (/<title>/i.test(html)) return;
      return [{ tag: "title", children: config.app.name, injectTo: "head" }];
    },
  };
}

export function parlorWeb(
  config: ParlorConfig,
  options: WebOptions = {},
): PluginOption[] {
  const root = options.root ?? process.cwd();
  const generated = generatedDir(root);
  const ownGeneratedDir = generated !== resolve(root, GENERATED_DIR);
  const manifest = agentManifest({
    app: {
      id: config.app.id,
      name: config.app.name,
      ...(config.app.description ? { description: config.app.description } : {}),
    },
    routeTree: routeTreeFile(config),
    generatedDir: generated,
  });
  const plugins: PluginOption[] = [
    ...fileRoutes(config, root),
    react(),
    cspPlugin(config),
    titlePlugin(config),
    manifest,
    serverRoutes(
      config.server.port,
      pageMatcher(() => manifest.api?.manifest()),
      { render: config.web.ssr !== undefined },
    ),
    {
      name: "parlor:web",
      config: () => ({
        // A run with its own generated directory may run beside another Vite on this root.
        ...(ownGeneratedDir ? { cacheDir: join(generated, "vite") } : {}),
        server: {
          port: config.web.port,
          strictPort: true,
          watch: { ignored: [`**/${GENERATED_DIR}/**`, join(generated, "**")] },
          proxy: Object.fromEntries(
            [FRAMEWORK_ROUTE_PREFIX, ...OAUTH_DISCOVERY_PREFIXES].map((prefix) => [
              prefix,
              `http://localhost:${config.server.port}`,
            ]),
          ),
        },
      }),
    },
  ];
  if (config.web.ssr) plugins.push(renderModule(config, root));
  if (config.web.pwa && !options.render) {
    plugins.push(
      serviceWorkerRegistration(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        manifest: webManifest(config, documentLang(root)),
        workbox: {
          skipWaiting: true,
          clientsClaim: true,
          navigateFallbackDenylist: [
            FRAMEWORK_ROUTE_PREFIX,
            ...OAUTH_DISCOVERY_PREFIXES,
          ].map((prefix) => new RegExp(`^${prefix.replaceAll(".", "\\.")}(/|$)`)),
          // A cached shell would stand in for the pages the server renders.
          ...(config.web.ssr
            ? {
                navigateFallback: null,
                globIgnores: ["**/node_modules/**/*", "index.html"],
              }
            : {}),
        },
        integration: {
          beforeBuildServiceWorker: (pwa) => {
            const pages = manifest.api?.manifest();
            if (!pages || config.web.ssr) return;
            pwa.workbox.navigateFallbackAllowlist = pages.routes.map((route) =>
              pagePattern(route.path),
            );
          },
        },
      }),
    );
  }
  return plugins;
}
