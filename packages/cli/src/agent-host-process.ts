import type { ChildProcess } from "node:child_process";

import type { LoadedConfig } from "@parlor/config";

export interface DevAgentHostOptions {
  /** `--no-agent-host` turns it off. */
  readonly enabled: boolean;
  /** The server is running with its own auth provider, so `devAuth` is not there to pair with. */
  readonly serverHasAuth: boolean;
}

/**
 * `parlor dev` runs `parlor-host dev --app http://localhost:<port>` next to the server, so
 * the chat works against the developer's own agents with no pairing. Orchestration only;
 * `undefined` when skipped.
 */
export function startDevAgentHost(
  loaded: LoadedConfig,
  options: DevAgentHostOptions,
): ChildProcess | undefined {
  // TODO: skip unless options.enabled && !options.serverHasAuth; spawn the @parlor/agent-host
  //   bin with ["dev", "--app", `http://localhost:${config.server.port}`] in rootDir, which
  //   retries the attach while the server boots; onShutdown(stop it).
  void loaded;
  void options;
  throw new Error("not implemented");
}
