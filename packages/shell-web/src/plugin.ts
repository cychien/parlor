import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { agentManifest, DEFAULT_ROUTE_TREE } from "@parlor/agent-ui/vite";
import { GENERATED_DIR, type ParlorConfig } from "@parlor/config";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { appCsp, metaCsp, serializeCsp } from "./csp.js";

export const FRAMEWORK_ROUTE_PREFIX = "/_parlor";
/** OAuth discovery lives at the origin root (RFC 8414, RFC 9728), outside the framework prefix. */
export const OAUTH_DISCOVERY_PREFIXES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
] as const;
export { DEFAULT_ROUTE_TREE };

export interface WebOptions {
  readonly conditions?: readonly string[] | undefined;
  readonly serverUrl?: string | undefined;
  readonly root?: string | undefined;
  /** Writes the policy into the built `index.html` for shells that serve it without HTTP headers. */
  readonly cspMeta?: boolean | undefined;
}

function isFrameworkPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return [FRAMEWORK_ROUTE_PREFIX, ...OAUTH_DISCOVERY_PREFIXES].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function cspPlugin(config: ParlorConfig, options: WebOptions): PluginOption {
  const serverOrigin = options.serverUrl || undefined;
  return {
    name: "parlor:csp",
    configureServer(server) {
      const header = serializeCsp(appCsp(config, { serverOrigin, dev: true }));
      server.middlewares.use((request, response, next) => {
        if (!isFrameworkPath(request.url)) {
          response.setHeader("content-security-policy", header);
        }
        next();
      });
    },
    transformIndexHtml(_html, context) {
      if (context.server || !options.cspMeta) return;
      const content = serializeCsp(metaCsp(appCsp(config, { serverOrigin })));
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export function webManifest(config: ParlorConfig) {
  return {
    id: config.app.id,
    name: config.app.name,
    short_name: config.app.name,
    ...(config.app.description ? { description: config.app.description } : {}),
    start_url: "/",
    display: "standalone" as const,
    theme_color: config.web.themeColor,
    background_color: config.web.backgroundColor,
  };
}

export function routeTreeFile(config: ParlorConfig): string {
  return config.web.routeTree ?? DEFAULT_ROUTE_TREE;
}

export function routesDirectory(config: ParlorConfig): string {
  return join(dirname(routeTreeFile(config)), "routes");
}

function fileRoutes(config: ParlorConfig, root: string): PluginOption[] {
  if (!existsSync(resolve(root, routesDirectory(config)))) return [];
  return [
    tanstackRouter({
      target: "react",
      routesDirectory: routesDirectory(config),
      generatedRouteTree: routeTreeFile(config),
      tmpDir: resolve(root, GENERATED_DIR, "tanstack"),
      quoteStyle: "double",
      semicolons: true,
    }),
  ];
}

export function parlorWeb(
  config: ParlorConfig,
  options: WebOptions = {},
): PluginOption[] {
  const conditions = options.conditions ?? [];
  const plugins: PluginOption[] = [
    ...fileRoutes(config, options.root ?? process.cwd()),
    react(),
    cspPlugin(config, options),
    agentManifest({
      app: {
        id: config.app.id,
        name: config.app.name,
        ...(config.app.description ? { description: config.app.description } : {}),
        ...(config.app.scheme ? { scheme: config.app.scheme } : {}),
      },
      routeTree: routeTreeFile(config),
    }),
    {
      name: "parlor:web",
      config: () => ({
        define: {
          "import.meta.env.PARLOR_SERVER_URL": JSON.stringify(options.serverUrl ?? ""),
        },
        resolve: { conditions: [...defaultClientConditions, ...conditions] },
        server: {
          port: config.web.port,
          strictPort: true,
          watch: { ignored: [`**/${GENERATED_DIR}/**`] },
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
  if (config.web.pwa) {
    plugins.push(
      VitePWA({
        registerType: "autoUpdate",
        manifest: webManifest(config),
        workbox: {
          navigateFallbackDenylist: [
            FRAMEWORK_ROUTE_PREFIX,
            ...OAUTH_DISCOVERY_PREFIXES,
          ].map((prefix) => new RegExp(`^${prefix.replaceAll(".", "\\.")}(/|$)`)),
        },
      }),
    );
  }
  return plugins;
}
