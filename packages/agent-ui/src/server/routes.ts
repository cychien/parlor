import type { H3 } from "h3";

import type { AgentUi } from "./agent-ui.js";
import { parseClientMessage } from "./schemas.js";

export const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;

export interface AgentUiRouteOptions {
  readonly basePath: string;
  readonly agentUi: AgentUi;
  readonly scope: (request: Request) => string | Promise<string>;
  readonly clientId: (request: Request) => string | undefined;
}

const status = (code: number) => new Response(null, { status: code });

export function registerAgentUiRoutes(app: H3, options: AgentUiRouteOptions): void {
  const { basePath, agentUi, scope, clientId } = options;

  app.post(`${basePath}/ui`, async (event) => {
    const request = event.req;
    if (Number(request.headers.get("content-length") ?? 0) > MAX_CLIENT_MESSAGE_BYTES) {
      return status(413);
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
      return status(413);
    }
    const id = clientId(request);
    if (!id) return status(400);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return status(400);
    }
    const message = parseClientMessage(json);
    if (!message) return status(400);
    const receipt = agentUi.receive(id, await scope(request), message);
    if (!receipt.accepted) return status(404);
    if (receipt.next === undefined) return status(204);
    return new Response(receipt.next, {
      headers: { "content-type": "application/json" },
    });
  });
}
