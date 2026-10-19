import type { UiManifest } from "@parlor/agent-ui";
import type { ActionDescriptor } from "@parlor/core/registry";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BASE_PATH = "/_parlor";
export const SOURCE_HEADER = "x-parlor-source";
export const CLIENT_HEADER = "x-parlor-client";
/** A native shell reads its bearer session from this response header after signing in. */
export const SESSION_TOKEN_HEADER = "set-auth-token";

export interface Manifest {
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly actions: readonly ActionDescriptor[];
  readonly ui?: UiManifest | undefined;
}
