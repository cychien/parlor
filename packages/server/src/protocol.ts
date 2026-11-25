import type { PageToolSpec, UiManifest } from "@parlor/agent-ui";
import type { ActionDescriptor } from "@parlor/core/registry";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BASE_PATH = "/_parlor";
export const SOURCE_HEADER = "x-parlor-source";
export const CLIENT_HEADER = "x-parlor-client";

export interface Manifest {
  readonly protocol: typeof PROTOCOL_VERSION;
  /** What a pairing host shows locally; filled once the server knows the app's name. */
  readonly app?: { readonly name: string } | undefined;
  readonly actions: readonly ActionDescriptor[];
  readonly ui?: UiManifest | undefined;
  /** The ui_ tools a page hands the browser's own agent through WebMCP. */
  readonly uiTools?: readonly PageToolSpec[] | undefined;
}
