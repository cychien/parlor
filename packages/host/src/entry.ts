import { UNROUTED_HEADER } from "@parlor/agent-ui";

export interface EntryOptions {
  readonly serverEntry: string;
  readonly basePath: string;
  readonly contentSecurityPolicy: string;
}

export const INDEX_HTML_PLACEHOLDER = "__PARLOR_INDEX_HTML__";
export const UI_MANIFEST_PLACEHOLDER = "__PARLOR_UI_MANIFEST__";
export const PAGE_ROUTES_PLACEHOLDER = "__PARLOR_PAGE_ROUTES__";

export const DURABLE_SERVER_BINDING = "PARLOR_SERVER";
export const DURABLE_SERVER_CLASS = "ParlorServer";

type DocumentOptions = Pick<EntryOptions, "basePath" | "contentSecurityPolicy">;

/**
 * A page route's document is served without asking the app. Any other request goes to the
 * app, and a browser gets the document only when no route of the app's matches either.
 */
const documentSource = ({
  basePath,
  contentSecurityPolicy,
}: DocumentOptions) => `const INDEX_HTML = ${INDEX_HTML_PLACEHOLDER};
const PAGE_ROUTES = ${PAGE_ROUTES_PLACEHOLDER};
const BASE_PATH = ${JSON.stringify(basePath)};
const DOCUMENT_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy": ${JSON.stringify(contentSecurityPolicy)},
};

function wantsDocument(request, path) {
  if (!INDEX_HTML || request.method !== "GET" || path.startsWith(BASE_PATH)) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function withDocument(request, serve) {
  const { pathname } = new URL(request.url);
  const document = wantsDocument(request, pathname);
  if (document && PAGE_ROUTES.some((page) => page.test(pathname))) {
    return new Response(INDEX_HTML, { headers: DOCUMENT_HEADERS });
  }
  const response = await serve(request);
  if (!document || response.status !== 404 || !response.headers.has(${JSON.stringify(UNROUTED_HEADER)})) {
    return response;
  }
  await response.body?.cancel();
  return new Response(INDEX_HTML, { headers: DOCUMENT_HEADERS });
}`;

export function hostEntrySource({ serverEntry, ...document }: EntryOptions): string {
  return `import app from ${JSON.stringify(serverEntry)};

const UI_MANIFEST = ${UI_MANIFEST_PLACEHOLDER};
${documentSource(document)}

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
  fetch(request) {
    return withDocument(request, (request) => app.fetch(request));
  },
};
`;
}

export interface CloudflareEntryOptions extends DocumentOptions {
  readonly locationHint?: string | undefined;
}

/** The stateless Worker: documents here, everything else to the one Durable Object. */
export function cloudflareEntrySource({
  locationHint,
  ...document
}: CloudflareEntryOptions): string {
  return `import { env } from "cloudflare:workers";

${documentSource(document)}

export default {
  fetch(request) {
    return withDocument(request, (request) => {
      const servers = env.${DURABLE_SERVER_BINDING};
      const server = servers.get(servers.idFromName("app")${locationHint ? `, { locationHint: ${JSON.stringify(locationHint)} }` : ""});
      return server.fetch(request);
    });
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
