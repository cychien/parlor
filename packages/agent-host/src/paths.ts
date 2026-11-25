import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HostPaths {
  readonly root: string;
  readonly grants: string;
  readonly trust: string;
  readonly policy: string;
  readonly sessions: string;
  readonly agents: string;
  /** What each agent last said about itself: its options and the account's allowance. */
  readonly learned: string;
  readonly control: string;
  readonly proxy: string;
  readonly lock: string;
  readonly logs: string;
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
    learned: join(root, "learned.json"),
    control: join(run, "control.sock"),
    proxy: join(run, "proxy.sock"),
    lock: join(root, "service.lock"),
    logs: join(root, "logs"),
    workspaces: join(home, "Parlor"),
  };
}
