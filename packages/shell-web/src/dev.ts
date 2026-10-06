import type { LoadedConfig } from "@parlor/config";
import { createServer, type ViteDevServer } from "vite";

import { parlorWeb } from "./plugin.js";

export async function startWebDev({
  config,
  rootDir,
}: LoadedConfig): Promise<ViteDevServer> {
  const server = await createServer({
    root: rootDir,
    plugins: parlorWeb(config),
  });
  await server.listen();
  server.printUrls();
  return server;
}
