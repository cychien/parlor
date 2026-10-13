import type { ActionDescriptor } from "@parlor/core/registry";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BASE_PATH = "/_parlor";
export const SOURCE_HEADER = "x-parlor-source";
export const CLIENT_HEADER = "x-parlor-client";

export interface Manifest {
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly actions: readonly ActionDescriptor[];
}
