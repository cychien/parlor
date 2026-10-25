import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { UI_MANIFEST_FILE } from "@parlor/agent-ui";
import { fileManifestSource, type UiManifestSource } from "@parlor/agent-ui/server";
import { generatedDir } from "@parlor/config";
import { serve } from "srvx";

import { registerCloudflareWorkers } from "./cloudflare/loader.js";
import { startCloudflarePlatform } from "./cloudflare/platform.js";
import type { CloudflareDev } from "./cloudflare/prepare.js";
import { onShutdown } from "./shutdown.js";

const {
  positionals: [entry],
  values: options,
} = parseArgs({ allowPositionals: true, options: { cloudflare: { type: "string" } } });
if (!entry) throw new Error("serve-entry needs the server entry path");

const cloudflare = options.cloudflare
  ? await startCloudflarePlatform(
      process.cwd(),
      JSON.parse(options.cloudflare) as CloudflareDev,
    )
  : undefined;
registerCloudflareWorkers();

const loaded = (await import(pathToFileURL(entry).href).catch(async (error: unknown) => {
  await cloudflare?.dispose();
  throw error;
})) as {
  default?: {
    fetch?: (request: Request) => Promise<Response> | Response;
    installUiManifest?: (source: UiManifestSource) => void;
    close?: () => Promise<void>;
  };
};
const handler = loaded.default?.fetch;
loaded.default?.installUiManifest?.(
  fileManifestSource(join(generatedDir(process.cwd()), UI_MANIFEST_FILE)),
);

if (handler || cloudflare) {
  onShutdown(async () => {
    await loaded.default?.close?.();
    await cloudflare?.dispose();
  });
}
if (handler) {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: (request) => handler(request), port, silent: true });
  console.log(`parlor server listening on http://localhost:${port}`);
}
