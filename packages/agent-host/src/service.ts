import type { ProtocolRange } from "@parlor/chat";

import type { HostPaths } from "./paths.js";

export interface HostRelease {
  readonly version: string;
  /** Host protocols it speaks with app backends. */
  readonly protocols: ProtocolRange;
  /** The control protocol it speaks with CLIs and desktop sidecars. */
  readonly control: number;
}

export type ServiceClient =
  | { readonly kind: "cli"; readonly release: HostRelease }
  | {
      readonly kind: "desktop-sidecar";
      readonly app: string;
      readonly release: HostRelease;
      /** The bundled binary, copied in when newer than what is installed. */
      readonly binary: string;
    };

export type AdoptOutcome =
  | { readonly kind: "using"; readonly running: HostRelease }
  | { readonly kind: "installed"; readonly release: HostRelease }
  /** The old service handed its links over; its running turns finish under it. */
  | { readonly kind: "upgraded"; readonly from: HostRelease; readonly to: HostRelease }
  | {
      readonly kind: "refused";
      readonly reason: "unsigned" | "downgrade" | "legacy_service";
      readonly running?: HostRelease;
    };

/**
 * Leaves exactly one per-user service running, the newest: adopt, install or upgrade.
 * Only binaries signed by the Parlor release key, never a downgrade; installs hold a lock
 * under `paths.root`, so two apps can run it at once.
 */
export async function ensureService(
  paths: HostPaths,
  client: ServiceClient,
): Promise<AdoptOutcome> {
  void paths;
  void client;
  throw new Error("not implemented");
}

/** LaunchAgent, systemd user unit or Task Scheduler, pointing at `paths.current`. */
export async function installLoginItem(paths: HostPaths): Promise<void> {
  void paths;
  throw new Error("not implemented");
}
