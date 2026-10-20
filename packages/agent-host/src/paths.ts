import { homedir } from "node:os";
import { join } from "node:path";

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
  void root;
  throw new Error("not implemented");
}
