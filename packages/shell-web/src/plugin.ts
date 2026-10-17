import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { agentManifest, DEFAULT_ROUTE_TREE } from "@parlor/agent-ui/vite";
import { GENERATED_DIR, type ParlorConfig } from "@parlor/config";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export const FRAMEWORK_ROUTE_PREFIX = "/_parlor";
export { DEFAULT_ROUTE_TREE };

export interface WebOptions {
  readonly conditions?: readonly string[] | undefined;
  readonly serverUrl?: string | undefined;
  readonly root?: string | undefined;
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
          proxy: {
            [FRAMEWORK_ROUTE_PREFIX]: `http://localhost:${config.server.port}`,
          },
        },
      }),
    },
  ];
  if (config.web.pwa) {
    plugins.push(VitePWA({ registerType: "autoUpdate", manifest: webManifest(config) }));
  }
  return plugins;
}
