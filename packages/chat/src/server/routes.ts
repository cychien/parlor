import { type AnyPluginRoute, pluginRoute } from "@parlor/server";

import type { LiveRelay } from "./live.js";
import type { ChatDb, ChatStore } from "./store.js";

export const MAX_STREAM_BODY_BYTES = 64 * 1024;

export interface ChatRouteDeps {
  readonly db: () => ChatDb;
  readonly store: ChatStore;
  readonly relay: LiveRelay;
  readonly heartbeatMs: number;
}

/** Plain routes only a host principal reaches, by type: no browser session, no agent token. */
export function chatRoutes(deps: ChatRouteDeps): readonly AnyPluginRoute[] {
  return [
    pluginRoute({
      method: "POST",
      path: "/stream",
      access: ["host"],
      handle: (request, caller) => {
        // TODO: read at most MAX_STREAM_BODY_BYTES (413 beyond); parse HostStreamBatch;
        //   holder = store.turnHolder(turnId), memoized per turn on this instance; a holder
        //   whose hostId or owner user differs from caller.principal -> 403;
        //   relay.accept(holder, batch); 204.
        void request;
        void caller;
        void deps;
        throw new Error("not implemented");
      },
    }),
    pluginRoute({
      method: "POST",
      path: "/heartbeat",
      access: ["host"],
      handle: (request, caller) => {
        // TODO: store.heartbeat(owner of caller, caller.principal, 2 * heartbeatMs); 204.
        void request;
        void caller;
        throw new Error("not implemented");
      },
    }),
  ];
}
