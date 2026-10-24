export interface EntryOptions {
  readonly serverEntry: string;
  readonly basePath: string;
}

export const INDEX_HTML_PLACEHOLDER = "__PARLOR_INDEX_HTML__";
export const UI_MANIFEST_PLACEHOLDER = "__PARLOR_UI_MANIFEST__";

export const DURABLE_SERVER_BINDING = "PARLOR_SERVER";
export const DURABLE_SERVER_CLASS = "ParlorServer";

const serveDocument = (basePath: string) => `const INDEX_HTML = ${INDEX_HTML_PLACEHOLDER};
const BASE_PATH = ${JSON.stringify(basePath)};

function wantsDocument(request) {
  if (request.method !== "GET") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

function documentFor(request) {
  if (!INDEX_HTML || !wantsDocument(request)) return undefined;
  if (new URL(request.url).pathname.startsWith(BASE_PATH)) return undefined;
  return new Response(INDEX_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}`;

export function hostEntrySource({ serverEntry, basePath }: EntryOptions): string {
  return `import app from ${JSON.stringify(serverEntry)};

const UI_MANIFEST = ${UI_MANIFEST_PLACEHOLDER};
${serveDocument(basePath)}

app.installUiManifest?.(() => UI_MANIFEST);

for (const signal of ["SIGINT", "SIGTERM"]) {
  globalThis.process?.once?.(signal, async () => {
    try {
      await app.close?.();
    } catch (error) {
      console.error("[parlor] shutdown failed:", error);
    }
    process.kill(process.pid, signal);
  });
}

export default {
  async fetch(request) {
    return documentFor(request) ?? app.fetch(request);
  },
};
`;
}

export interface CloudflareEntryOptions {
  readonly basePath: string;
  readonly locationHint?: string | undefined;
}

/** The stateless Worker: documents here, everything else to the one Durable Object. */
export function cloudflareEntrySource({
  basePath,
  locationHint,
}: CloudflareEntryOptions): string {
  return `import { env } from "cloudflare:workers";

${serveDocument(basePath)}

export default {
  async fetch(request) {
    const document = documentFor(request);
    if (document) return document;
    const servers = env.${DURABLE_SERVER_BINDING};
    const server = servers.get(servers.idFromName("app")${locationHint ? `, { locationHint: ${JSON.stringify(locationHint)} }` : ""});
    return server.fetch(request);
  },
};
`;
}

export interface DurableServerOptions {
  readonly serverEntry: string;
  readonly connectionScopes: boolean;
  /** The app's own Worker exports, such as its Durable Object classes. */
  readonly workerExports?: string | undefined;
}

/**
 * The app's server, imported on the Durable Object's first request: workerd allows no I/O
 * or timers while a module loads, and server.ts may await its database at the top level.
 */
export function durableServerSource({
  serverEntry,
  connectionScopes,
  workerExports,
}: DurableServerOptions): string {
  return `import { DurableObject } from "cloudflare:workers";
${connectionScopes ? 'import { createConnectionScope } from "@parlor/data";\n' : ""}${workerExports ? `export * from ${JSON.stringify(workerExports)};\n` : ""}
const UI_MANIFEST = ${UI_MANIFEST_PLACEHOLDER};

let loading;
function app() {
  return (loading ??= import(${JSON.stringify(serverEntry)}).then(({ default: server }) => {
    server.installUiManifest?.(() => UI_MANIFEST);
    return server;
  }));
}

export class ${DURABLE_SERVER_CLASS} extends DurableObject {
${connectionScopes ? "  #connections = createConnectionScope();\n\n" : ""}  fetch(request) {
    ${connectionScopes ? "return this.#connections.run(async () => (await app()).fetch(request));" : "return app().then((server) => server.fetch(request));"}
  }
}
`;
}
