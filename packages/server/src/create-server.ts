import { pagePattern, UNROUTED_HEADER } from "@parlor/agent-ui";
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
  type DataProvider,
  decodeReadRequests,
  REFRESH_HEADER,
} from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";
import type { ServerChannel } from "@parlor/sync";
import {
  ensureSyncTables,
  recordSyncEvent,
  registerSyncRoutes,
  type SyncDatabase,
  SyncHub,
  type SyncTransport,
} from "@parlor/sync/server";
import { H3, type H3Event, readBody } from "h3";

import { admits, requireAccess, requireSurface, type Surface } from "./access.js";
import { type ActionRunner, createActionRunner } from "./actions.js";
import { AuthFailure, type AuthProvider } from "./auth.js";
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
  options: ServerOptions<T>,
): FrameworkServer {
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
      for (const { runtime } of runtimes) runtime.start?.();
    })());
  const callers = createCallerResolver(auth, scope, ready);
  const host: PluginHost = {
    basePath,
    database,
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
        await recordSyncEvent(within as SyncDatabase, { scope: target, tags });
        return;
      }
      await ready();
      await database.transaction((tx) =>
        recordSyncEvent(tx as SyncDatabase, { scope: target, tags }),
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
    agentUiOptions === false
      ? undefined
      : createAgentUi({
          ...agentUiOptions,
          audience: async (request) => (await callers(request)).audience,
        });
  const runnerFor = (
    registry: ActionRegistry,
    admit?: (caller: Caller) => Promise<void>,
  ): ActionRunner =>
    createActionRunner({
      actions: registry,
      scope,
      callers,
      database,
      sync: syncEnabled,
      onClient: agentUi?.touch,
      confirm: agentUi?.confirm,
      audit,
      admit,
      ready,
    });
  const runner = runnerFor(actions);
  const hub = database ? new SyncHub(database) : undefined;
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
    return { ...summary, actions: actions.describe(), ...(ui ? { ui } : {}) };
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
        actions,
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

  if (mcp !== false) {
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
      app: mcpApp,
      ...mcp,
    });
    const guardMcp = guard(callers, "mcp");
    app.all(`${basePath}/mcp`, async (event) => {
      try {
        await guardMcp(event.req);
      } catch (error) {
        const refusal = toActionError(error);
        const challenged =
          refusal.code === "unauthenticated" ||
          (await callers(event.req).then(
            ({ principal }) => principal.kind === "host",
            () => false,
          ));
        return challenged && auth ? auth.challenge(event.req) : errorResponse(refusal);
      }
      return handler.fetch(event.req);
    });
  }

  if (syncEnabled && database && hub) {
    app.use(`${basePath}/sync/**`, refuseUnless(callers, "sync"));
    app.use(`${basePath}/sync/**`, async () => {
      await ready();
    });
    registerSyncRoutes(app, {
      basePath,
      data: database,
      hub,
      scope: async (request) => (await callers(request)).scope,
      audience: async (request) => (await callers(request)).audience,
      authority: async (request) => {
        const caller = await callers(request);
        const { principal } = caller;
        return {
          principal,
          channels: admits("channels", caller, callers.enforcing),
          ...(auth && principal.kind !== "anonymous"
            ? { revoked: auth.revoked(principal) }
            : {}),
        };
      },
      transport: syncOptions?.transport,
      pollIntervalMs: syncOptions?.pollIntervalMs,
      channels: [
        ...(agentUi ? [agentUi.channel] : []),
        ...runtimes.flatMap((entry): ServerChannel[] =>
          entry.runtime.channel ? [gatedChannel(entry, entry.runtime.channel)] : [],
        ),
      ],
      clientId: clientOf,
    });
  }

  if (agentUi) {
    app.use(`${basePath}/ui`, refuseUnless(callers, "ui"));
    registerAgentUiRoutes(app, {
      basePath,
      agentUi,
      audience: async (request) => (await callers(request)).audience,
      clientId: clientOf,
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

  return {
    installUiManifest: (source) => {
      refuseShadowedRoutes(source(), routes);
      agentUi?.install(source);
    },
    fetch: (request) => {
      const response = Promise.resolve(app.fetch(request));
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
