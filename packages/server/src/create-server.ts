import { pagePattern, type PresenceUpdate, UNROUTED_HEADER } from "@parlor/agent-ui";
import {
  type AgentUiOptions,
  createAgentUi,
  registerAgentUiRoutes,
  type UiManifestInput,
  type UiManifestSource,
} from "@parlor/agent-ui/server";
import {
  ActionError,
  type ActionErrorCode,
  type ActionMap,
  ANONYMOUS,
  type ConfirmationPolicy,
  type DataProvider,
  decodeReadRequests,
  hasUser,
  REFRESH_HEADER,
} from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";
import {
  BUILD_HEADER,
  type ServerChannel,
  SYNC_BUILD_PATH,
  SYNC_SOCKET_PATH,
} from "@parlor/sync";
import {
  ensureSyncTables,
  recordSyncEvent,
  registerSyncRoutes,
  type HostedSocket,
  type SocketPlatform,
  type SyncDatabase,
  SyncHub,
  syncNotifyOf,
  type SyncSockets,
  type SyncTransport,
  ticketAccount,
} from "@parlor/sync/server";
import { H3, type H3Event, readBody } from "h3";

import { admits, requireAccess, requireSurface, type Surface } from "./access.js";
import { type ActionRunner, createActionRunner } from "./actions.js";
import { AuthFailure, type AuthProvider } from "./auth.js";
import { serverBuild } from "./build.js";
import {
  type Caller,
  type CallerResolver,
  clientOf,
  createCallerResolver,
  sourceOf,
} from "./caller.js";
import { type CorsConfig, corsMiddleware } from "./cors.js";
import { devAuth } from "./dev-auth.js";
import { createMcpHandler } from "./mcp.js";
import { applyMigrations, checkMigrations } from "./migrations.js";
import type {
  ActionAudit,
  AnyPluginRoute,
  PluginCaller,
  PluginHost,
  PluginRuntime,
  ServerPlugin,
} from "./plugin.js";
import { DEFAULT_BASE_PATH, type Manifest, PROTOCOL_VERSION } from "./protocol.js";
import { refreshReads } from "./refresh.js";
import { defaultScope, type ScopeResolver } from "./scope.js";
import {
  type ActionVisibility,
  createRegistryResolver,
  type RegistryResolver,
} from "./visibility.js";

export interface SyncOptions {
  readonly transport?: SyncTransport | undefined;
  readonly pollIntervalMs?: number | undefined;
}

export interface ServerOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope?: ScopeResolver | undefined;
  /**
   * Without it every caller is anonymous, the action source is the `x-parlor-source`
   * header, and confirmations are a UX guard.
   */
  readonly auth?: AuthProvider | undefined;
  /** Framework features with their own tables and routes, installed after `auth`. */
  readonly plugins?: readonly ServerPlugin[] | undefined;
  readonly basePath?: string | undefined;
  readonly cors?: CorsConfig | false | undefined;
  readonly database?: DataProvider | undefined;
  readonly mcp?:
    | { readonly name?: string | undefined; readonly version?: string | undefined }
    | false
    | undefined;
  readonly sync?: SyncOptions | false | undefined;
  readonly agentUi?: AgentUiOptions | false | undefined;
  /**
   * Decides, for each call, whether the user approves it in the app first (`ask`), it runs
   * (`proceed`) or it fails with `confirmation_unavailable` (`refuse`). Defaults to
   * `defaultConfirmationPolicy`: agents are asked about `confirm: true` actions and keys are
   * refused them.
   */
  readonly confirmation?: ConfirmationPolicy | undefined;
  /**
   * Which of `actions` each caller may see and call, decided once per request. A hidden
   * action is left out of the manifest and MCP `tools/list`, and a call to it answers
   * `not_found` like an action that does not exist. Plugins' actions are never filtered.
   * Absent, every action is visible.
   */
  readonly visible?: ActionVisibility | undefined;
}

type ManifestSummary = Pick<Manifest, "protocol" | "app">;
type ManifestReply = Manifest | ManifestSummary | Response;

export interface FrameworkServer {
  /**
   * Hands the server the app's page routes, called by the host before the first request.
   * Throws when a page route would take a document request meant for an absolute route.
   */
  readonly installUiManifest?: ((source: UiManifestSource) => void) | undefined;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
  /**
   * Hands the server the sockets its runtime holds while it sleeps, such as a Durable Object
   * with hibernation; the host calls it in every instance before anything else. Sync then
   * offers clients sockets, which cost an idle server nothing.
   */
  readonly installSockets?: ((platform: SocketPlatform) => void) | undefined;
  /** The runtime saw one of those sockets close. */
  readonly socketClosed?: ((socket: HostedSocket) => Promise<void>) | undefined;
  /** The alarm `SocketPlatform.wakeAt` asked for. */
  readonly alarm?: (() => Promise<void>) | undefined;
  /**
   * Gets ready and wires the sockets it slept through, for a runtime woken by something
   * other than a request, such as a notification from the bus.
   */
  readonly awaken?: (() => Promise<void>) | undefined;
  /**
   * The app as a stateless edge and one server per account, for a host that runs them in
   * separate runtimes (`cloudflare-scaled`). The same object on every call.
   */
  readonly split?: (() => SplitServer) | undefined;
}

/** Serves everything that holds no live state; answers which account's server takes the rest. */
export interface EdgeServer extends FrameworkServer {
  /**
   * The account whose server must serve `request`: live connections, the agent's view of the
   * screen and plugins that keep state in memory. Undefined when the edge serves it.
   */
  placement(request: Request): Promise<string | undefined>;
  /** Finishes what the plugins held back while serving; the host keeps the request alive until it settles. */
  settle(): Promise<void>;
}

export interface SplitServer {
  readonly edge: EdgeServer;
  /**
   * A new server for the account `key` (from `EdgeServer.placement`), built from its own call
   * of the options function, so nothing it holds is shared with another account's server.
   * Call it once per runtime that serves the account.
   */
  account(key: string): FrameworkServer;
}

/** A server may be built more than once from a function: once per runtime when the host splits it. */
export type ServerOptionsSource<T extends ActionMap> =
  | ServerOptions<T>
  | (() => ServerOptions<T>);

type Role =
  | { readonly kind: "whole" }
  | { readonly kind: "edge" }
  | { readonly kind: "account"; readonly key: string };

/** The account of callers with no user and no key: every visitor of an app without sign-in. */
export const ANONYMOUS_ACCOUNT = "anonymous";

function base64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Who a caller's live state belongs to: its user, a key's scope, or nobody in particular. */
function accountOf(caller: Caller): string {
  const { principal } = caller;
  if (hasUser(principal)) return `u${base64Url(principal.userId)}`;
  if (principal.kind === "key") return `k${base64Url(caller.scope)}`;
  return ANONYMOUS_ACCOUNT;
}

const STATUS_BY_CODE = {
  not_found: 404,
  invalid_input: 400,
  declined: 403,
  confirmation_timeout: 504,
  confirmation_unavailable: 503,
  unauthenticated: 401,
  forbidden: 403,
  internal: 500,
} as const satisfies Record<ActionErrorCode, number>;

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function toActionError(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  if (error instanceof AuthFailure)
    return new ActionError("unauthenticated", error.message);
  if (!isAbort(error)) console.error("[parlor] action failed:", error);
  return new ActionError("internal", "Internal error", { cause: error });
}

function errorBody(event: H3Event, error: unknown) {
  const actionError = toActionError(error);
  event.res.status = STATUS_BY_CODE[actionError.code];
  return actionError.toBody();
}

function errorResponse(error: unknown): Response {
  const actionError = toActionError(error);
  return Response.json(actionError.toBody(), {
    status: STATUS_BY_CODE[actionError.code],
  });
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "actions",
  "manifest",
  "mcp",
  "sync",
  "ui",
]);

function checkPlugins(
  plugins: readonly ServerPlugin[],
  database: DataProvider | undefined,
): void {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (!PLUGIN_NAME.test(plugin.name) || RESERVED_NAMES.has(plugin.name)) {
      throw new Error(`"${plugin.name}" cannot name a plugin.`);
    }
    if (names.has(plugin.name))
      throw new Error(`Two plugins are named "${plugin.name}".`);
    names.add(plugin.name);
    checkMigrations(plugin);
    if (plugin.migrations?.length && !database) {
      throw new Error(`The "${plugin.name}" plugin needs a database.`);
    }
  }
}

interface MountedRoute {
  readonly plugin: string;
  readonly route: AnyPluginRoute;
  readonly path: string;
}

const isAbsolute = (route: AnyPluginRoute) =>
  route.absolute === true || route.path.startsWith("/.well-known/");

function mountRoutes(
  runtimes: readonly { readonly plugin: ServerPlugin; readonly runtime: PluginRuntime }[],
  basePath: string,
): MountedRoute[] {
  const mounted: MountedRoute[] = [];
  const owners = new Map<string, string>();
  for (const { plugin, runtime } of runtimes) {
    for (const route of runtime.routes ?? []) {
      if (!isAbsolute(route)) {
        mounted.push({
          plugin: plugin.name,
          route,
          path: `${basePath}/${plugin.name}${route.path}`,
        });
        continue;
      }
      const { method, path } = route;
      if (route.absolute && /[:*]/.test(path)) {
        throw new Error(
          `The "${plugin.name}" plugin's absolute route ${method} ${path} must be a static path.`,
        );
      }
      if (path === basePath || path.startsWith(`${basePath}/`)) {
        throw new Error(
          `The "${plugin.name}" plugin's absolute route ${method} ${path} is under ${basePath}, which the framework serves.`,
        );
      }
      const key = `${method} ${path}`;
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          owner === plugin.name
            ? `The "${owner}" plugin serves ${key} twice.`
            : `The "${owner}" and "${plugin.name}" plugins both serve ${key}.`,
        );
      }
      owners.set(key, plugin.name);
      mounted.push({ plugin: plugin.name, route, path });
    }
  }
  return mounted;
}

function refuseShadowedRoutes(
  manifest: UiManifestInput | undefined,
  routes: readonly MountedRoute[],
): void {
  if (!manifest) return;
  const pages = manifest.routes.map((page) => ({
    page,
    pattern: pagePattern(page.path),
  }));
  for (const { plugin, route } of routes) {
    if (!route.absolute || route.method !== "GET") continue;
    const shadow = pages.find(({ pattern }) => pattern.test(route.path));
    if (shadow) {
      throw new Error(
        `The "${plugin}" plugin's absolute route GET ${route.path} is also matched by the page route ${shadow.page.path}, so a browser opening it would get the page. Move one of them.`,
      );
    }
  }
}

function auditAll(
  runtimes: readonly PluginRuntime[],
): ((record: ActionAudit) => void) | undefined {
  const hooks = runtimes.filter((runtime) => runtime.audit);
  if (hooks.length === 0) return undefined;
  return (record) => {
    for (const runtime of hooks) runtime.audit?.(record);
  };
}

interface Installed {
  readonly plugin: ServerPlugin;
  readonly runtime: PluginRuntime;
}

async function allowedBy({ runtime }: Installed, caller: PluginCaller): Promise<boolean> {
  return !runtime.allows || (await runtime.allows(caller));
}

function admitterOf(installed: Installed) {
  return async (caller: PluginCaller): Promise<void> => {
    if (await allowedBy(installed, caller)) return;
    throw new ActionError(
      "forbidden",
      `This account cannot use ${installed.plugin.name}.`,
    );
  };
}

/** Joins a connection to `channel` only once the plugin admits its holder. */
function gatedChannel(installed: Installed, channel: ServerChannel): ServerChannel {
  if (!installed.runtime.allows) return channel;
  return {
    event: channel.event,
    hosts: channel.hosts,
    connect(connection) {
      let detach: (() => void) | undefined;
      let left = false;
      allowedBy(installed, {
        principal: connection.principal ?? ANONYMOUS,
        scope: connection.scope,
      }).then(
        (allowed) => {
          if (allowed && !left && !connection.closed?.aborted) {
            detach = channel.connect(connection);
          }
        },
        (error: unknown) => {
          console.error(`[parlor] ${installed.plugin.name}: access check failed:`, error);
        },
      );
      return () => {
        left = true;
        detach?.();
      };
    },
  };
}

function guard(callers: CallerResolver, surface: Surface) {
  return async (request: Request): Promise<Caller> =>
    requireSurface(await callers(request), surface, callers.enforcing);
}

function refuseUnless(callers: CallerResolver, surface: Surface) {
  const check = guard(callers, surface);
  return async (event: H3Event): Promise<Response | undefined> => {
    try {
      await check(event.req);
      return undefined;
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createServer<T extends ActionMap>(
  source: ServerOptionsSource<T>,
): FrameworkServer {
  const optionsOf = typeof source === "function" ? source : () => source;
  const whole = buildServer(optionsOf(), { kind: "whole" });
  let split: SplitServer | undefined;
  return {
    ...whole,
    split: () =>
      (split ??= {
        edge: buildServer(optionsOf(), { kind: "edge" }) as EdgeServer,
        account: (key) => {
          if (typeof source !== "function") {
            throw new Error(
              "A host that runs a server per account needs createServer(() => ({ ... })): each account's server builds its own auth and plugins.",
            );
          }
          return buildServer(source(), { kind: "account", key });
        },
      }),
  };
}

function buildServer<T extends ActionMap>(
  options: ServerOptions<T>,
  role: Role,
): FrameworkServer | EdgeServer {
  const edge = role.kind === "edge";
  const {
    actions,
    scope = defaultScope,
    plugins = [],
    basePath = DEFAULT_BASE_PATH,
    cors = {},
    database,
    mcp = {},
    sync = {},
    agentUi: agentUiOptions = {},
    confirmation,
  } = options;
  const auth = options.auth ?? (process.env.PARLOR_DEV === "1" ? devAuth() : undefined);
  const app = new H3();
  const appName = process.env.PARLOR_APP_NAME || undefined;
  const syncOptions = sync === false ? undefined : sync;
  const syncEnabled = syncOptions !== undefined && database !== undefined;
  const installed = [...(auth ? [auth] : []), ...plugins];
  checkPlugins(installed, database);
  let prepared: Promise<void> | undefined;
  const ready = () =>
    (prepared ??= (async () => {
      if (database) {
        await database.prepare?.();
        if (syncEnabled) await ensureSyncTables(database.read() as SyncDatabase);
        await applyMigrations(database, installed);
      }
      if (!edge) for (const { runtime } of runtimes) runtime.start?.();
    })());
  const callers = createCallerResolver(auth, scope, ready);
  const registryFor = createRegistryResolver(actions, options.visible, callers);
  const notify = database ? syncNotifyOf(database) : undefined;
  const host: PluginHost = {
    basePath,
    // Nothing at the edge outlives a request to hear a notification: plugins ask the database.
    database: edge && database ? withoutListen(database) : database,
    instances:
      role.kind === "account"
        ? "one"
        : edge
          ? "many"
          : database?.notifications === "process"
            ? "one"
            : "many",
    ...(auth ? { auth } : {}),
    authMisconfigured: "auth" in options && auth === undefined,
    callerOf: callers,
    allows: async (name, caller) => {
      const entry = runtimes.find(({ plugin }) => plugin.name === name);
      return entry === undefined || (await allowedBy(entry, caller));
    },
    ready,
    announce: async (target, tags, within) => {
      if (!syncEnabled || !database || tags.length === 0) return;
      if (within !== undefined) {
        await recordSyncEvent(within as SyncDatabase, { scope: target, tags }, notify);
        return;
      }
      await ready();
      await database.transaction((tx) =>
        recordSyncEvent(tx as SyncDatabase, { scope: target, tags }, notify),
      );
    },
  };
  const runtimes: Installed[] = installed.map((plugin) => ({
    plugin,
    runtime: plugin.setup(host),
  }));
  const routes = mountRoutes(runtimes, basePath);
  const audit = auditAll(runtimes.map(({ runtime }) => runtime));
  const agentUi =
    agentUiOptions === false || edge
      ? undefined
      : createAgentUi({
          ...agentUiOptions,
          audience: async (request) => (await callers(request)).audience,
        });
  const runnerFor = (
    registry: ActionRegistry,
    admit?: (caller: Caller) => Promise<void>,
    registryOf?: RegistryResolver,
  ): ActionRunner =>
    createActionRunner({
      actions: registry,
      scope,
      callers,
      database,
      sync: syncEnabled,
      onClient: agentUi?.touch,
      confirm: agentUi?.confirm,
      confirmation,
      audit,
      admit,
      registryFor: registryOf,
      ready,
    });
  const runner = runnerFor(actions, undefined, registryFor);
  const hub = database && !edge ? new SyncHub(database) : undefined;
  let sockets: SyncSockets | undefined;
  const inflight = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  if (cors !== false) app.use(corsMiddleware(cors));

  app.get(`${basePath}/manifest`, async (event): Promise<ManifestReply> => {
    let caller: Caller;
    try {
      caller = await callers(event.req);
    } catch (error) {
      return errorResponse(error);
    }
    const summary: ManifestSummary = {
      protocol: PROTOCOL_VERSION,
      ...(appName ? { app: { name: appName } } : {}),
    };
    if (!admits("manifest", caller, callers.enforcing)) return summary;
    const ui = agentUi?.manifest();
    let visible: ActionRegistry;
    try {
      visible = await registryFor(event.req);
    } catch (error) {
      return errorResponse(error);
    }
    return { ...summary, actions: visible.describe(), ...(ui ? { ui } : {}) };
  });

  app.post(`${basePath}/actions/:name`, async (event) => {
    const name = event.context.params?.name ?? "";
    try {
      const input = await readBody(event).catch(() => {
        throw new ActionError("invalid_input", "Request body must be JSON");
      });
      const source = sourceOf(event.req);
      const run = (action: string, actionInput: unknown) =>
        runner.run(action, actionInput, event.req, source, {
          surface: "actions",
          cursor: true,
        });
      const result = await run(name, input);
      const answer = { data: result.data, tags: result.reads, cursor: result.cursor };
      const reads = decodeReadRequests(event.req.headers.get(REFRESH_HEADER));
      if (!reads) return answer;
      const refreshed = await refreshReads(
        await registryFor(event.req),
        reads,
        result.writes,
        async (action, actionInput) => {
          const read = await run(action, actionInput);
          return { data: read.data, tags: read.reads, cursor: read.cursor };
        },
        (error) => toActionError(error).toBody(),
      );
      return { ...answer, writes: result.writes, refreshed };
    } catch (error) {
      return errorBody(event, error);
    }
  });

  const handleRoute = async (
    route: AnyPluginRoute,
    request: Request,
    admit: (caller: PluginCaller) => Promise<void>,
  ) => {
    if (route.access === "public") return route.handle(request);
    const caller = requireAccess(await callers(request), route.access, callers.enforcing);
    await admit(caller);
    return route.handle(request, caller);
  };

  const admitters = new Map(
    runtimes.map((entry) => [entry.plugin.name, admitterOf(entry)]),
  );
  for (const entry of runtimes) {
    const { plugin, runtime } = entry;
    if (runtime.actions) {
      const admit = admitters.get(plugin.name)!;
      const pluginRunner = runnerFor(runtime.actions, runtime.allows ? admit : undefined);
      app.post(`${basePath}/${plugin.name}/actions/:name`, async (event) => {
        const name = event.context.params?.name ?? "";
        try {
          const input = await readBody(event).catch(() => {
            throw new ActionError("invalid_input", "Request body must be JSON");
          });
          const result = await pluginRunner.run(
            name,
            input,
            event.req,
            sourceOf(event.req),
            { surface: "pluginActions", cursor: true },
          );
          return { data: result.data, tags: result.reads, cursor: result.cursor };
        } catch (error) {
          return errorBody(event, error);
        }
      });
    }
  }
  for (const { plugin, route, path } of routes) {
    const admit = admitters.get(plugin)!;
    app.on(route.method, path, async (event) => {
      try {
        await ready();
        return await handleRoute(route, event.req, admit);
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  if (mcp !== false && !edge) {
    const mcpApp = appName
      ? {
          name: appName,
          ...(process.env.PARLOR_APP_DESCRIPTION
            ? { description: process.env.PARLOR_APP_DESCRIPTION }
            : {}),
        }
      : undefined;
    const handler = createMcpHandler({
      actions,
      runner,
      agentUi,
      callers,
      confirmation,
      registryFor,
      turnTools: runtimes.flatMap(({ runtime }) => runtime.tools ?? []),
      app: mcpApp,
      ...mcp,
    });
    const guardMcp = guard(callers, "mcp");
    app.all(`${basePath}/mcp`, async (event) => {
      try {
        await guardMcp(event.req);
      } catch (error) {
        const refusal = toActionError(error);
        const signInHelps = !(error instanceof AuthFailure) || error.challenge;
        const challenged =
          (refusal.code === "unauthenticated" && signInHelps) ||
          (await callers(event.req).then(
            ({ principal }) => principal.kind === "host",
            () => false,
          ));
        return challenged && auth ? auth.challenge(event.req) : errorResponse(refusal);
      }
      try {
        await registryFor(event.req);
      } catch (error) {
        return errorResponse(error);
      }
      return handler.fetch(event.req);
    });
  }

  if (syncEnabled && database && hub) {
    const refuseSync = refuseUnless(callers, "sync");
    const asksBuild = (event: H3Event) =>
      event.url.pathname === `${basePath}${SYNC_BUILD_PATH}`;
    app.use(`${basePath}/sync/**`, (event) =>
      asksBuild(event) ? undefined : refuseSync(event),
    );
    app.use(`${basePath}/sync/**`, async (event) => {
      if (!asksBuild(event)) await ready();
    });
    sockets = registerSyncRoutes(app, {
      basePath,
      ticketPrefix: role.kind === "account" ? role.key : undefined,
      data: database,
      hub,
      scope: async (request) => (await callers(request)).scope,
      audience: async (request) => (await callers(request)).audience,
      account: async (request) => (await callers(request)).account,
      authority: async (request) => {
        const caller = await callers(request);
        const { principal } = caller;
        return {
          principal,
          channels: admits("channels", caller, callers.enforcing)
            ? true
            : (channel: ServerChannel) =>
                principal.kind === "host" && channel.hosts === true,
          ...(auth && hasUser(principal) ? { revoked: auth.revoked(principal) } : {}),
        };
      },
      revokedOf: (principal) =>
        auth && hasUser(principal) ? auth.revoked(principal) : undefined,
      restored: ({ clientId, audience, remembered }) => {
        if (agentUi && audience !== undefined && isPresence(remembered)) {
          agentUi.receive(clientId, audience, remembered);
        }
      },
      transport: syncOptions?.transport,
      pollIntervalMs: syncOptions?.pollIntervalMs,
      build: serverBuild,
      channels: [
        ...(agentUi ? [agentUi.channel] : []),
        ...runtimes.flatMap((entry): ServerChannel[] =>
          entry.runtime.channel ? [gatedChannel(entry, entry.runtime.channel)] : [],
        ),
      ],
      clientId: clientOf,
    }).sockets;
  }

  if (agentUi) {
    app.use(`${basePath}/ui`, refuseUnless(callers, "ui"));
    registerAgentUiRoutes(app, {
      basePath,
      agentUi,
      audience: async (request) => (await callers(request)).audience,
      clientId: clientOf,
      accepted: (clientId, message) => {
        if (message.type === "presence") sockets?.remember(clientId, message);
        else if (message.type === "leave") sockets?.remember(clientId, undefined);
      },
    });
  }

  app.all("/**", (event) => {
    const response = errorResponse(
      new ActionError(
        "not_found",
        `No route for ${event.req.method} ${event.url.pathname}`,
      ),
    );
    response.headers.set(UNROUTED_HEADER, "1");
    return response;
  });

  const socketPath = `${basePath}${SYNC_SOCKET_PATH}`;
  /**
   * With sockets held for it, the server first wires those it slept through, so a write this
   * request makes reaches them, and answers a socket's opening itself: its response is not
   * one the router may rebuild.
   */
  const serve = async (request: Request): Promise<Response> => {
    if (!sockets?.installed) return stampBuild(await app.fetch(request));
    await ready();
    await sockets.ensure();
    if (new URL(request.url).pathname === socketPath) return sockets.open(request);
    return stampBuild(await app.fetch(request));
  };

  const realtime = [
    `${basePath}/sync`,
    `${basePath}/ui`,
    `${basePath}/mcp`,
    ...installed
      .filter((plugin) => plugin.realtime)
      .map((plugin) => `${basePath}/${plugin.name}`),
  ];
  const placement = async (request: Request): Promise<string | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === socketPath) {
      return ticketAccount(url.searchParams.get("ticket") ?? "") ?? ANONYMOUS_ACCOUNT;
    }
    const live = realtime.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    );
    if (!live) return undefined;
    try {
      return accountOf(await callers(request));
    } catch {
      // The account's server refuses it the same way, with the answer the caller expects.
      return ANONYMOUS_ACCOUNT;
    }
  };

  const settle = async () => {
    const settled = await Promise.allSettled(
      runtimes.map(({ runtime }) => runtime.settle?.()),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        console.error(
          "[parlor] a plugin could not settle after a request:",
          result.reason,
        );
      }
    }
  };

  return {
    ...(edge ? { placement, settle } : {}),
    installUiManifest: (source) => {
      refuseShadowedRoutes(source(), routes);
      agentUi?.install(source);
    },
    installSockets: sockets
      ? (platform) => {
          sockets!.install(platform);
        }
      : undefined,
    socketClosed: sockets
      ? async (socket) => {
          await ready();
          await sockets!.closed(socket);
        }
      : undefined,
    alarm: sockets ? () => sockets!.alarm() : undefined,
    awaken: async () => {
      await ready();
      await sockets?.ensure();
    },
    fetch: (request) => {
      const response = serve(request);
      const settled = () => void inflight.delete(response);
      inflight.add(response);
      response.then(settled, settled);
      return response;
    },
    close: () =>
      (closing ??= (async () => {
        agentUi?.close();
        await Promise.allSettled(runtimes.map(({ runtime }) => runtime.close?.()));
        await Promise.all([hub?.stop(), Promise.allSettled([...inflight])]);
        await database?.close?.();
      })()),
  };
}

/** `database` with no `listen`, keeping methods bound to it, so a class-based provider still works. */
function withoutListen(database: DataProvider): DataProvider {
  return new Proxy(database, {
    get(target, property) {
      if (property === "listen") return undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (target, property) => property !== "listen" && Reflect.has(target, property),
  });
}

function isPresence(value: unknown): value is PresenceUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "presence"
  );
}

/** Names the build on a response, copying one whose headers cannot change, such as a proxied fetch's. */
function stampBuild(response: Response): Response {
  try {
    response.headers.set(BUILD_HEADER, serverBuild());
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(BUILD_HEADER, serverBuild());
    return copy;
  }
}
