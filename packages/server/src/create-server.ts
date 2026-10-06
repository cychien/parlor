import { ActionError, type ActionMap, type ActionSource } from "@fw/core";
import { type ActionRegistry, invokeAction } from "@fw/core/registry";
import { H3, readBody } from "h3";

import {
  DEFAULT_BASE_PATH,
  type Manifest,
  PROTOCOL_VERSION,
  SOURCE_HEADER,
} from "./protocol.js";
import { defaultScope, type ScopeResolver } from "./scope.js";

export interface ServerOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope?: ScopeResolver | undefined;
  readonly basePath?: string | undefined;
}

export interface FrameworkServer {
  readonly fetch: (request: Request) => Promise<Response>;
}

const STATUS_BY_CODE = { not_found: 404, invalid_input: 400, internal: 500 } as const;
const SOURCES: ReadonlySet<string> = new Set<ActionSource>([
  "ui",
  "agent",
  "http",
  "mcp",
]);

function sourceOf(request: Request): ActionSource {
  const header = request.headers.get(SOURCE_HEADER);
  return header && SOURCES.has(header) ? (header as ActionSource) : "http";
}

function errorResponse(error: unknown): Response {
  const actionError =
    error instanceof ActionError
      ? error
      : new ActionError("internal", "Internal error", { cause: error });
  return Response.json(actionError.toBody(), {
    status: STATUS_BY_CODE[actionError.code],
  });
}

export function createServer<T extends ActionMap>(
  options: ServerOptions<T>,
): FrameworkServer {
  const { actions, scope = defaultScope, basePath = DEFAULT_BASE_PATH } = options;
  const app = new H3();

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
      const ctx = {
        scope: await scope(event.req),
        source: sourceOf(event.req),
        signal: event.req.signal,
      };
      const data = await invokeAction(actions, name, input, ctx);
      return { data };
    } catch (error) {
      return errorResponse(error);
    }
  });

  return { fetch: (request) => Promise.resolve(app.fetch(request)) };
}
