import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HostPaths {
  readonly root: string;
  readonly grants: string;
  readonly trust: string;
  readonly sessions: string;
  readonly agents: string;
  readonly control: string;
  readonly proxy: string;
  readonly versions: string;
  /** What the login item points at; a link into `versions/<version>/`, never into an app bundle. */
  readonly current: string;
  readonly workspaces: string;
}

export function hostPaths(root: string = join(homedir(), ".parlor", "host")): HostPaths {
  const run = join(root, "run");
  return {
    root,
    grants: join(root, "grants.json"),
    trust: join(root, "trust.json"),
    sessions: join(root, "sessions.json"),
    agents: join(root, "agents.json"),
    control: join(run, "control.sock"),
    proxy: join(run, "proxy.sock"),
    versions: join(root, "versions"),
    current: join(root, "current"),
    workspaces: join(dirname(dirname(root)), "Parlor"),
  };
}
