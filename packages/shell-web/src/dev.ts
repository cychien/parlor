import type { LoadedConfig } from "@parlor/config";
import { createServer, type ViteDevServer } from "vite";

import type { WebOptions } from "./plugin.js";
import { parlorViteConfig } from "./vite-config.js";

export async function startWebDev(
  loaded: LoadedConfig,
  options: WebOptions = {},
): Promise<ViteDevServer> {
  const server = await createServer(parlorViteConfig(loaded, options, {}));
  await server.listen();
  server.printUrls();
  return server;
}
