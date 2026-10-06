import type { LoadedConfig } from "@parlor/config";
import { createServer, type ViteDevServer } from "vite";

import { parlorWeb, type WebOptions } from "./plugin.js";

export async function startWebDev(
  { config, rootDir }: LoadedConfig,
  options: WebOptions = {},
): Promise<ViteDevServer> {
  const server = await createServer({
    root: rootDir,
    configFile: false,
    plugins: parlorWeb(config, options),
  });
  await server.listen();
  server.printUrls();
  return server;
}
