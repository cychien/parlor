import type { ClientChannel } from "@parlor/sync";
import type { AnyRouter } from "@tanstack/router-core";

import type {
  AgentOrigin,
  ClientMessage,
  QuerySnapshot,
  RouteSnapshot,
  ScreenSnapshot,
  UiOp,
} from "../protocol.js";
import type { BrowserEnvironment } from "./environment.js";
import type { ViewRegistry } from "./registry.js";
import type { ScreenLimits } from "./screen.js";

export interface QuerySource {
  active(): readonly QuerySnapshot[];
  settled(timeoutMs: number): Promise<void>;
}

export interface AgentUiClientOptions {
  readonly router?: AnyRouter | undefined;
  readonly queries: QuerySource;
  readonly send: (message: ClientMessage) => Promise<string | undefined>;
  readonly platform: string;
  readonly buildId?: string | undefined;
  readonly environment?: BrowserEnvironment | undefined;
  readonly limits?: Partial<ScreenLimits> | undefined;
  readonly dev?: boolean | undefined;
}

export interface AgentActivity {
  readonly busy: boolean;
  readonly last:
    | { readonly op: UiOp; readonly origin: AgentOrigin; readonly at: number }
    | undefined;
}

export interface ActivityStore {
  subscribe(listener: () => void): () => void;
  get(): AgentActivity;
}

export interface AgentUiClient extends ClientChannel {
  readonly views: ViewRegistry;
  readonly activity: ActivityStore;
  screen(): Promise<ScreenSnapshot>;
  start(): () => void;
}

export function routeSnapshot(router: AnyRouter): RouteSnapshot | null {
  void router;
  throw new Error("not implemented");
}

export function createAgentUiClient(options: AgentUiClientOptions): AgentUiClient {
  void options;
  throw new Error("not implemented");
}
