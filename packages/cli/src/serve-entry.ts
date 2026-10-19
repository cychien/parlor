import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { UI_MANIFEST_FILE } from "@parlor/agent-ui";
import { fileManifestSource, type UiManifestSource } from "@parlor/agent-ui/server";
import { GENERATED_DIR } from "@parlor/config";
import { serve } from "srvx";

import { onShutdown } from "./shutdown.js";

const entry = process.argv[2];
if (!entry) throw new Error("serve-entry needs the server entry path");

const loaded = (await import(pathToFileURL(entry).href)) as {
  default?: {
    fetch?: (request: Request) => Promise<Response> | Response;
    installUiManifest?: (source: UiManifestSource) => void;
    close?: () => Promise<void>;
  };
};
const handler = loaded.default?.fetch;
loaded.default?.installUiManifest?.(
  fileManifestSource(resolve(GENERATED_DIR, UI_MANIFEST_FILE)),
);

if (handler) {
  onShutdown(() => loaded.default?.close?.());
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: (request) => handler(request), port });
  console.log(`parlor server listening on http://localhost:${port}`);
}
