import type { ParlorConfig } from "@parlor/config";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export const FRAMEWORK_ROUTE_PREFIX = "/_parlor";

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

export function parlorWeb(config: ParlorConfig): PluginOption[] {
  const plugins: PluginOption[] = [
    react(),
    {
      name: "parlor:web",
      config: () => ({
        server: {
          port: config.web.port,
          strictPort: true,
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
