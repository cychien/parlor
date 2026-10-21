import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { LocalAgentHost } from "./interface.js";

export { capacitorLocalAgentHost } from "./capacitor.js";
export type {
  HostPairing,
  LocalAgentHost,
  LocalConnectInput,
  LocalConnectResult,
  LocalHostStatus,
} from "./interface.js";
export { tauriLocalAgentHost } from "./tauri.js";
export { webLocalAgentHost } from "./web.js";

export const localAgentHost = defineCapability<LocalAgentHost>({
  name: "localAgentHost",
  adapters: platformAdapters.localAgentHost,
});
