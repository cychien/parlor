import type { AgentLauncher } from "./acp.js";
import type { GrantStore, HostKeys } from "./grants.js";
import type { McpProxy } from "./mcp-proxy.js";
import type { HostPaths } from "./paths.js";
import type { RemotePolicy } from "./policy.js";
import type { SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import type { HostRelease } from "./service.js";

export interface DaemonDeps {
  readonly release: HostRelease;
  readonly paths: HostPaths;
  readonly grants: GrantStore;
  readonly keys: HostKeys;
  readonly pool: SessionPool;
  readonly proxy: McpProxy;
  readonly launcher: AgentLauncher;
  readonly prompter: LocalPrompter;
  readonly policy: RemotePolicy;
}

/**
 * One per user per computer, for every app: an `AppLink` per grant, the session pool,
 * the proxy socket and the control socket. Started only through `ensureService`.
 */
export interface HostDaemon {
  start(): Promise<void>;
  connect(appOrigin: string): Promise<void>;
  disconnect(appOrigin: string): Promise<void>;
  stop(): Promise<void>;
}

export function createHostDaemon(deps: DaemonDeps): HostDaemon {
  // TODO: control socket at paths.control; per grant createAppLink(grant, { onWake: claim
  //   loop with one running turn per thread through runTurn, onRevoked: pool.drop,
  //   grants.remove, keys.remove }); proxy.listen(paths.proxy); SIGTERM ->
  //   links report offline, pool kills the agents' process groups.
  void deps;
  throw new Error("not implemented");
}
