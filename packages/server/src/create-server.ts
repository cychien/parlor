import {
  type AgentUiOptions,
  createAgentUi,
  registerAgentUiRoutes,
  type UiManifestSource,
} from "@parlor/agent-ui/server";
import { ActionError, type ActionMap, type DataProvider } from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";
import { registerSyncRoutes, SyncHub, type SyncTransport } from "@parlor/sync/server";
import { H3, type H3Event, readBody } from "h3";

import { clientOf, createActionRunner, sourceOf } from "./actions.js";
import { type CorsConfig, corsMiddleware } from "./cors.js";
import { createMcpHandler } from "./mcp.js";
import { DEFAULT_BASE_PATH, type Manifest, PROTOCOL_VERSION } from "./protocol.js";
import { defaultScope, type ScopeResolver } from "./scope.js";

export interface SyncOptions {
  readonly transport?: SyncTransport | undefined;
  readonly pollIntervalMs?: number | undefined;
}

export interface ServerOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope?: ScopeResolver | undefined;
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

export interface FrameworkServer {
  readonly installUiManifest?: ((source: UiManifestSource) => void) | undefined;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

const STATUS_BY_CODE = { not_found: 404, invalid_input: 400, internal: 500 } as const;

function errorBody(event: H3Event, error: unknown) {
  if (!(error instanceof ActionError)) console.error("[parlor] action failed:", error);
  const actionError =
    error instanceof ActionError
      ? error
      : new ActionError("internal", "Internal error", { cause: error });
  event.res.status = STATUS_BY_CODE[actionError.code];
  return actionError.toBody();
}

export function createServer<T extends ActionMap>(
  options: ServerOptions<T>,
): FrameworkServer {
  const {
    actions,
    scope = defaultScope,
    basePath = DEFAULT_BASE_PATH,
    cors = {},
    database,
    mcp = {},
    sync = {},
    agentUi: agentUiOptions = {},
  } = options;
  const app = new H3();
  const syncOptions = sync === false ? undefined : sync;
  const syncEnabled = syncOptions !== undefined && database !== undefined;
  const agentUi =
    agentUiOptions === false ? undefined : createAgentUi({ ...agentUiOptions, scope });
  const runner = createActionRunner({
    actions,
    scope,
    database,
    sync: syncEnabled,
    onClient: agentUi?.touch,
  });
  const hub = database ? new SyncHub(database) : undefined;

  if (cors !== false) app.use(corsMiddleware(cors));

  app.get(`${basePath}/manifest`, (): Manifest => ({
    protocol: PROTOCOL_VERSION,
    actions: actions.describe(),
  }));

  app.post(`${basePath}/actions/:name`, async (event) => {
    const name = event.context.params?.name ?? "";
    try {
      const input = await readBody(event).catch(() => {
        throw new ActionError("invalid_input", "Request body must be JSON");
      });
      const result = await runner.run(name, input, event.req, sourceOf(event.req));
      return { data: result.data, tags: result.reads };
    } catch (error) {
      return errorBody(event, error);
    }
  });

  if (mcp !== false) {
    const handler = createMcpHandler({ actions, runner, agentUi, ...mcp });
    app.all(`${basePath}/mcp`, (event) => handler.fetch(event.req));
  }

  if (syncEnabled && database && hub) {
    app.use(`${basePath}/sync/**`, async () => {
      await runner.ready();
    });
    registerSyncRoutes(app, {
      basePath,
      data: database,
      hub,
      scope,
      transport: syncOptions?.transport,
      pollIntervalMs: syncOptions?.pollIntervalMs,
      channels: agentUi ? [agentUi.channel] : [],
      clientId: clientOf,
    });
  }

  if (agentUi)
    registerAgentUiRoutes(app, { basePath, agentUi, scope, clientId: clientOf });

  return {
    fetch: (request) => Promise.resolve(app.fetch(request)),
    close: async () => {
      agentUi?.close();
      await hub?.stop();
    },
  };
}
