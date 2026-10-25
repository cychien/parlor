import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { pagePattern } from "@parlor/agent-ui";
import { agentManifest, DEFAULT_ROUTE_TREE } from "@parlor/agent-ui/vite";
import { GENERATED_DIR, generatedDir, type ParlorConfig } from "@parlor/config";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { appCsp, metaCsp, serializeCsp } from "./csp.js";
import { routeGeneratorOptions, routesDirectory, routeTreeFile } from "./route-tree.js";
import { pageMatcher, serverRoutes } from "./server-routes.js";
import { renderModule } from "./ssr.js";

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
  /** The origin every target of one `parlor dev` signs for and pairs with, when it is not this page's. */
  readonly appOrigin?: string | undefined;
  readonly root?: string | undefined;
  /** Writes the policy into the built `index.html` for shells that serve it without HTTP headers. */
  readonly cspMeta?: boolean | undefined;
  /** Builds the server render module (`web.ssr`) instead of the browser app. */
  readonly render?: boolean | undefined;
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
  const conditions = options.conditions ?? [];
  const root = options.root ?? process.cwd();
  const generated = generatedDir(root);
  const ownGeneratedDir = generated !== resolve(root, GENERATED_DIR);
  const manifest = agentManifest({
    app: {
      id: config.app.id,
      name: config.app.name,
      ...(config.app.description ? { description: config.app.description } : {}),
      ...(config.app.scheme ? { scheme: config.app.scheme } : {}),
    },
    routeTree: routeTreeFile(config),
    generatedDir: generated,
  });
  const plugins: PluginOption[] = [
    ...fileRoutes(config, root),
    react(),
    cspPlugin(config, options),
    titlePlugin(config),
    manifest,
    serverRoutes(
      config.server.port,
      pageMatcher(() => manifest.api?.manifest()),
      {
        // A native shell's platform conditions: it runs the static build, never a server render.
        render: config.web.ssr !== undefined && conditions.length === 0,
      },
    ),
    {
      name: "parlor:web",
      config: () => ({
        define: {
          "import.meta.env.PARLOR_SERVER_URL": JSON.stringify(options.serverUrl ?? ""),
          "import.meta.env.PARLOR_APP_ORIGIN": JSON.stringify(options.appOrigin ?? ""),
          "import.meta.env.PARLOR_APP_SCHEME": JSON.stringify(config.app.scheme ?? ""),
        },
        resolve: { conditions: [...defaultClientConditions, ...conditions] },
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
      VitePWA({
        registerType: "autoUpdate",
        manifest: webManifest(config),
        workbox: {
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
