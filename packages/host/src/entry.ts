import { UNROUTED_HEADER } from "@parlor/agent-ui";

import { locationHintForDatabase } from "./location-hint.js";
import { readUnreadBody, UNREAD_BODY_LIMIT_BYTES } from "./unread-body.js";

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

/**
 * The Durable Object's name. A hint only places an object when it is first created, so the
 * name follows the hint: setting or changing it starts the server where it says. The server
 * keeps nothing in the object's own storage, so the new one starts complete.
 */
export function durableServerName(locationHint: string | undefined): string {
  return locationHint ? `app@${locationHint}` : "app";
}

/**
 * The stateless Worker: documents here, everything else to the one Durable Object, started
 * beside the database. The configured hint wins; without one, the region `DATABASE_URL` names.
 */
export function cloudflareEntrySource({
  locationHint,
  ...document
}: CloudflareEntryOptions): string {
  return `import { env } from "cloudflare:workers";

${documentSource(document)}

${locationHintForDatabase.toString()}

${durableServerName.toString()}

const CONFIGURED_HINT = ${JSON.stringify(locationHint ?? null)};
let placement;

export default {
  fetch(request) {
    return withDocument(request, (request) => {
      if (!placement) {
        const hint = CONFIGURED_HINT ?? locationHintForDatabase(env.DATABASE_URL);
        placement = { name: durableServerName(hint), options: hint ? { locationHint: hint } : {} };
      }
      const servers = env.${DURABLE_SERVER_BINDING};
      return servers.get(servers.idFromName(placement.name), placement.options).fetch(request);
    });
  },
};
`;
}

export interface DurableServerOptions {
  readonly serverEntry: string;
  readonly connectionScopes: boolean;
  /** The app has `@parlor/server`, whose sockets outlast the object's hibernation. */
  readonly sockets?: boolean | undefined;
  /** The app's own Worker exports, such as its Durable Object classes. */
  readonly workerExports?: string | undefined;
}

/**
 * The app's server, imported on the Durable Object's first request: workerd allows no I/O
 * or timers while a module loads, and server.ts may await its database at the top level.
 * The object hands the server the sockets it holds while it hibernates (`installSockets`),
 * answers their pings without waking, and passes their closes and its alarm on.
 */
export function durableServerSource({
  serverEntry,
  connectionScopes,
  sockets,
  workerExports,
}: DurableServerOptions): string {
  return `import { DurableObject } from "cloudflare:workers";
${sockets ? 'import { hostedSockets } from "@parlor/server";\n' : ""}${connectionScopes ? 'import { createConnectionScope } from "@parlor/data";\n' : ""}${workerExports ? `export * from ${JSON.stringify(workerExports)};\n` : ""}
const UI_MANIFEST = ${UI_MANIFEST_PLACEHOLDER};

let loading;
function app() {
  return (loading ??= import(${JSON.stringify(serverEntry)}).then(({ default: server }) => {
    server.installUiManifest?.(() => UI_MANIFEST);
    return server;
  }));
}

${readUnreadBody.toString()}

export class ${DURABLE_SERVER_CLASS} extends DurableObject {
${connectionScopes ? "  #connections = createConnectionScope();\n" : ""}  #sockets;

  constructor(ctx, env) {
    super(ctx, env);
${sockets ? "    this.#sockets = hostedSockets(ctx);\n" : ""}
  }

  #serve(work) {
    const run = async () => {
      const server = await app();
      if (this.#sockets) server.installSockets?.(this.#sockets);
      return work(server);
    };
    return ${connectionScopes ? "this.#connections.run(run)" : "run()"};
  }

  async fetch(request) {
    const response = await this.#serve((server) => server.fetch(request));
    await readUnreadBody(request, ${UNREAD_BODY_LIMIT_BYTES});
    return response;
  }

  webSocketMessage() {}

  webSocketClose(socket) {
    return this.#serve((server) => this.#sockets && server.socketClosed?.(this.#sockets.of(socket)));
  }

  webSocketError(socket) {
    return this.webSocketClose(socket);
  }

  alarm() {
    return this.#serve((server) => server.alarm?.());
  }
}
`;
}

export const ACCOUNT_BINDING = "PARLOR_ACCOUNTS";
export const ACCOUNT_CLASS = "ParlorAccount";
export const TOPIC_BINDING = "PARLOR_TOPICS";
export const TOPIC_CLASS = "ParlorTopic";
/** Set by the Worker on what it hands an account's Durable Object; a client's own is dropped. */
export const ACCOUNT_HEADER = "x-parlor-account";

/** The Durable Object that relays one topic of one notification channel. */
export function topicName(channel: string, topic: string): string {
  return `${channel}\u0000${topic}`;
}

export interface ScaledEntryOptions extends DocumentOptions {
  readonly serverEntry: string;
  readonly locationHint?: string | undefined;
}

/**
 * The stateless Worker of `cloudflare-scaled`: it serves the app's edge in a connection
 * scope of its own per request, whose notifications go to the topics' Durable Objects, and
 * hands live connections, the agent's view and stateful plugins to the caller's account
 * object. With a Hyperdrive binding it reaches the database through it.
 */
export function scaledEntrySource({
  serverEntry,
  locationHint,
  ...document
}: ScaledEntryOptions): string {
  return `import { env, waitUntil } from "cloudflare:workers";
import { createConnectionScope } from "@parlor/data";

${documentSource(document)}

${locationHintForDatabase.toString()}

${topicName.toString()}

const UI_MANIFEST = ${UI_MANIFEST_PLACEHOLDER};
const CONFIGURED_HINT = ${JSON.stringify(locationHint ?? null)};
const ACCOUNT_HEADER = ${JSON.stringify(ACCOUNT_HEADER)};

let loading;
function edge() {
  return (loading ??= (async () => {
    if (env.HYPERDRIVE?.connectionString && process.env.DATABASE_URL) {
      process.env.DATABASE_DIRECT_URL ??= process.env.DATABASE_URL;
      process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
    }
    const { default: server } = await import(${JSON.stringify(serverEntry)});
    const split = server.split?.();
    if (!split) throw new Error("cloudflare-scaled serves a server from @parlor/server's createServer.");
    split.edge.installUiManifest?.(() => UI_MANIFEST);
    return split.edge;
  })());
}

let accountHint;
function account(key) {
  accountHint ??= { hint: CONFIGURED_HINT ?? locationHintForDatabase(env.DATABASE_URL) };
  const accounts = env.${ACCOUNT_BINDING};
  return accounts.get(accounts.idFromName(key), accountHint.hint ? { locationHint: accountHint.hint } : {});
}

const bus = {
  publish: (channel, topic, payload) => {
    const topics = env.${TOPIC_BINDING};
    return topics.get(topics.idFromName(topicName(channel, topic))).publish(channel, topic, payload, null);
  },
  // The edge never listens: nothing it starts outlives the request.
  subscribe: async () => {},
  unsubscribe: async () => {},
};

function forAccount(request, key) {
  const headers = new Headers(request.headers);
  headers.set(ACCOUNT_HEADER, key);
  return new Request(request, { headers });
}

export default {
  async fetch(request) {
    const scope = createConnectionScope({ bus });
    const headers = new Headers(request.headers);
    headers.delete(ACCOUNT_HEADER);
    const incoming = new Request(request, { headers });
    try {
      return await withDocument(incoming, (request) =>
        scope.run(async () => {
          const server = await edge();
          let key;
          try {
            key = await server.placement(request);
          } catch (error) {
            console.error("[parlor] could not tell whose account serves a request:", error);
            return Response.json(
              { error: { code: "internal", message: "The server is unavailable. Try again shortly." } },
              { status: 503 },
            );
          }
          if (key === undefined) return server.fetch(request);
          return account(key).fetch(forAccount(request, key));
        }),
      );
    } finally {
      // The scope is never closed here: work the app hands to waitUntil may still use its
      // connections, and workerd ends them with the request once all of that has settled.
      waitUntil(
        scope
          .run(async () => (await edge()).settle())
          .catch((error) => console.error("[parlor] settling after a request failed:", error)),
      );
    }
  },
};
`;
}

export interface ScaledServerOptions {
  readonly serverEntry: string;
  /** The app's own Worker exports, such as its Durable Object classes. */
  readonly workerExports?: string | undefined;
}

/**
 * The Durable Objects of `cloudflare-scaled`. `ParlorAccount` serves one account: its live
 * connections as sockets it holds while it hibernates, the agent's view and stateful plugins,
 * from a server built for it alone; it hears the topics it listens to from `ParlorTopic`,
 * which keeps who listens to one topic and relays what is published on it.
 */
export function scaledServerSource({
  serverEntry,
  workerExports,
}: ScaledServerOptions): string {
  return `import { DurableObject } from "cloudflare:workers";
import { hostedSockets } from "@parlor/server";
import { createConnectionScope } from "@parlor/data";
${workerExports ? `export * from ${JSON.stringify(workerExports)};\n` : ""}
const UI_MANIFEST = ${UI_MANIFEST_PLACEHOLDER};
const ACCOUNT_HEADER = ${JSON.stringify(ACCOUNT_HEADER)};
const ACCOUNT_KEY = "parlor:account";

${topicName.toString()}

${readUnreadBody.toString()}

let loading;
function app() {
  return (loading ??= import(${JSON.stringify(serverEntry)}).then(({ default: server }) => {
    if (!server.split) throw new Error("cloudflare-scaled serves a server from @parlor/server's createServer.");
    return server;
  }));
}

export class ${ACCOUNT_CLASS} extends DurableObject {
  #key;
  #server;
  #sockets;
  #scope;

  constructor(ctx, env) {
    super(ctx, env);
    this.#sockets = hostedSockets(ctx);
    const topic = (channel, name) => env.${TOPIC_BINDING}.get(env.${TOPIC_BINDING}.idFromName(topicName(channel, name)));
    this.#scope = createConnectionScope({
      bus: {
        publish: (channel, name, payload) => topic(channel, name).publish(channel, name, payload, this.#key),
        subscribe: (channel, name) => topic(channel, name).subscribe(this.#key),
        unsubscribe: (channel, name) => topic(channel, name).unsubscribe(this.#key),
      },
    });
  }

  async #account(given) {
    if (this.#key) return this.#key;
    const kept = await this.ctx.storage.get(ACCOUNT_KEY);
    if (given && kept !== given) await this.ctx.storage.put(ACCOUNT_KEY, given);
    this.#key = given ?? kept;
    if (!this.#key) throw new Error("This account's Durable Object does not know its account yet.");
    return this.#key;
  }

  #serve(given, work) {
    return this.#scope.run(async () => {
      const key = await this.#account(given);
      if (!this.#server) {
        this.#server = (await app()).split().account(key);
        this.#server.installUiManifest?.(() => UI_MANIFEST);
      }
      this.#server.installSockets?.(this.#sockets);
      return work(this.#server);
    });
  }

  async fetch(request) {
    const response = await this.#serve(request.headers.get(ACCOUNT_HEADER) ?? undefined, (server) => server.fetch(request));
    await readUnreadBody(request, ${UNREAD_BODY_LIMIT_BYTES});
    return response;
  }

  webSocketMessage() {}

  webSocketClose(socket) {
    return this.#serve(undefined, (server) => server.socketClosed?.(this.#sockets.of(socket)));
  }

  webSocketError(socket) {
    return this.webSocketClose(socket);
  }

  alarm() {
    return this.#serve(undefined, (server) => server.alarm?.());
  }

  /** What a topic it listens to relays; false once nobody here listens, so the topic forgets it. */
  deliver(channel, topic, payload) {
    return this.#serve(undefined, async (server) => {
      await server.awaken?.();
      return this.#scope.deliver(channel, topic, payload);
    });
  }
}

export class ${TOPIC_CLASS} extends DurableObject {
  async subscribe(account) {
    if (account) await this.ctx.storage.put("s:" + account, 1);
  }

  async unsubscribe(account) {
    if (account) await this.ctx.storage.delete("s:" + account);
  }

  /**
   * Relays to every account listening but the one that published, without waiting for them.
   * An account nobody listens in any more unsubscribes itself, in turn with its own calls.
   */
  async publish(channel, topic, payload, from) {
    const listening = await this.ctx.storage.list({ prefix: "s:" });
    for (const key of listening.keys()) {
      const account = key.slice(2);
      if (account === from) continue;
      const accounts = this.env.${ACCOUNT_BINDING};
      accounts
        .get(accounts.idFromName(account))
        .deliver(channel, topic, payload)
        .catch((error) => console.error("[parlor] a topic could not reach an account:", error));
    }
  }
}
`;
}
