import type { HostStreamBatch, HostWelcome } from "@parlor/chat";
import type { ChatHostActionMap } from "@parlor/chat/server";
import type { PluginClient } from "@parlor/client";

import type { AppGrant, HostKeys } from "./grants.js";

export const RECONNECT_MAX_MS = 4_000;
export const ACTIVE_POLL_MS = 2_000;
export const IDLE_POLL_MS = 15_000;

export interface HostApi {
  readonly calls: PluginClient<ChatHostActionMap>;
  /** At most one post in flight per turn; frames produced meanwhile coalesce into the next. */
  stream(batch: HostStreamBatch): void;
  heartbeat(): Promise<void>;
}

export interface AppLinkDeps {
  readonly keys: HostKeys;
  readonly hostVersion: string;
  readonly hostName: string;
  readonly platform: string;
  readonly fetch: typeof fetch;
  /** A turn may be waiting: claim until not_found, then ask for running turns' signals. */
  readonly onWake: (link: AppLink) => void;
  /** Any 401, or the stream closed for revocation. */
  readonly onRevoked: (grant: AppGrant) => void;
  /** No shared protocol: shown locally ("update Parlor Host"); the link stays down. */
  readonly onIncompatible: (
    grant: AppGrant,
    welcome: Extract<HostWelcome, { readonly accepted: false }>,
  ) => void;
}

/** The host's whole conversation with one app, each request carrying a fresh assertion. */
export interface AppLink {
  readonly grant: AppGrant;
  readonly api: HostApi;
  /** Set once `hostHello` was welcomed; every other call waits for it. */
  readonly protocol: number | undefined;
  start(): void;
  stop(options?: { readonly revoke?: boolean | undefined }): Promise<void>;
}

export function createAppLink(grant: AppGrant, deps: AppLinkDeps): AppLink {
  // TODO: action client with a fetch that sets `authorization: ParlorHost
  //   ${keys.assert(origin, { method, url })}` per request; calls =
  //   createPluginClient(client, "chat"); hostHello first, refused -> onIncompatible;
  //   createSyncClient({ coalesceMs: 0, reconnectMaxMs: RECONNECT_MAX_MS, onEvents:
  //   parlor_chat tags -> onWake, onUnauthorized -> onRevoked }); on a poll transport,
  //   ACTIVE_POLL_MS while a turn runs or the user was active in two minutes, else
  //   IDLE_POLL_MS; heartbeat every welcome.heartbeatMs.
  void grant;
  void deps;
  throw new Error("not implemented");
}
