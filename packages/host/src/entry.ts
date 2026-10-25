import { UNROUTED_HEADER } from "@parlor/agent-ui";

export interface RenderEntryOptions {
  /** The module `parlor build` built from `web.ssr`, exporting `render`. */
  readonly module: string;
  /** The page policy with `{nonce}` in `script-src`, replaced per response. */
  readonly contentSecurityPolicy: string;
}

export interface EntryOptions {
  readonly serverEntry: string;
  readonly basePath: string;
  readonly contentSecurityPolicy: string;
  readonly render?: RenderEntryOptions | undefined;
}

export const NONCE_PLACEHOLDER = "{nonce}";

export const INDEX_HTML_PLACEHOLDER = "__PARLOR_INDEX_HTML__";
export const UI_MANIFEST_PLACEHOLDER = "__PARLOR_UI_MANIFEST__";
export const PAGE_ROUTES_PLACEHOLDER = "__PARLOR_PAGE_ROUTES__";

export const DURABLE_SERVER_BINDING = "PARLOR_SERVER";
export const DURABLE_SERVER_CLASS = "ParlorServer";

type DocumentOptions = Pick<
  EntryOptions,
  "basePath" | "contentSecurityPolicy" | "render"
>;

/** Imported on the first page it renders, keeping the app's pages out of the server's startup. */
const renderSource = (render: RenderEntryOptions | undefined) =>
  render
    ? `let rendering;
const loadRender = () => (rendering ??= import(${JSON.stringify(render.module)}).then((module) => module.render));
const RENDERED_POLICY = ${JSON.stringify(render.contentSecurityPolicy)};

function createNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

async function renderPage(request, serve) {
  const nonce = createNonce();
  try {
    const page = await (await loadRender())(request, { template: INDEX_HTML, fetch: serve, nonce });
    if (!page) return undefined;
    const response = new Response(page.body, page);
    response.headers.set("content-security-policy", RENDERED_POLICY.replace(${JSON.stringify(NONCE_PLACEHOLDER)}, nonce));
    if (!response.headers.has("cache-control")) response.headers.set("cache-control", "private, no-cache");
    return response;
  } catch (error) {
    console.error(\`[parlor] Rendering \${request.url} on the server failed, so it is served without:\`, error);
    return undefined;
  }
}`
    : "const renderPage = async () => undefined;";

/**
 * A page route's document is rendered on the server when its routes opt in, and is
 * `index.html` otherwise, without asking the app. Any other request goes to the app, and a
 * browser gets the document only when no route of the app's matches either.
 */
const documentSource = ({
  basePath,
  contentSecurityPolicy,
  render,
}: DocumentOptions) => `const INDEX_HTML = ${INDEX_HTML_PLACEHOLDER};
const PAGE_ROUTES = ${PAGE_ROUTES_PLACEHOLDER};
const BASE_PATH = ${JSON.stringify(basePath)};
const DOCUMENT_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy": ${JSON.stringify(contentSecurityPolicy)},
};

${renderSource(render)}

function wantsDocument(request, path) {
  if (!INDEX_HTML || request.method !== "GET" || path.startsWith(BASE_PATH)) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function withDocument(request, serve) {
  const { pathname } = new URL(request.url);
  if (INDEX_HTML && pathname === "/index.html") {
    return new Response(INDEX_HTML, { headers: DOCUMENT_HEADERS });
  }
  const document = wantsDocument(request, pathname);
  if (document && PAGE_ROUTES.some((page) => page.test(pathname))) {
    return (await renderPage(request, serve)) ?? new Response(INDEX_HTML, { headers: DOCUMENT_HEADERS });
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
