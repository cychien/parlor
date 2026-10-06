import type { ActionDescriptor } from "@fw/core/registry";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BASE_PATH = "/_fw";
export const SOURCE_HEADER = "x-fw-source";

export interface Manifest {
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly actions: readonly ActionDescriptor[];
}
