import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HostPaths {
  readonly root: string;
  readonly grants: string;
  readonly trust: string;
  readonly policy: string;
  readonly sessions: string;
  readonly agents: string;
  readonly control: string;
  readonly proxy: string;
  readonly versions: string;
  /** What the login item points at; a link into `versions/<version>/`, never into an app bundle. */
  readonly current: string;
  /** Held by `ensureService` from the first look at the service until it answers. */
  readonly lock: string;
  readonly logs: string;
  readonly launchAgent: string;
  readonly workspaces: string;
}

export function hostPaths(root: string = join(homedir(), ".parlor", "host")): HostPaths {
  const run = join(root, "run");
  const home = dirname(dirname(root));
  return {
    root,
    grants: join(root, "grants.json"),
    trust: join(root, "trust.json"),
    policy: join(root, "policy.json"),
    sessions: join(root, "sessions.json"),
    agents: join(root, "agents.json"),
    control: join(run, "control.sock"),
    proxy: join(run, "proxy.sock"),
    versions: join(root, "versions"),
    current: join(root, "current"),
    lock: join(root, "service.lock"),
    logs: join(root, "logs"),
    launchAgent: join(home, "Library", "LaunchAgents", "dev.parlor.host.plist"),
    workspaces: join(home, "Parlor"),
  };
}
