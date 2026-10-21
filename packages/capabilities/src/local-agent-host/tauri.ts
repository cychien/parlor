import type { CapabilityAdapter } from "../capability.js";
import { hasNativeCommands } from "../device-key/native.js";
import type { TauriInvoke } from "../device-key/tauri.js";
import type {
  HostPairing,
  LocalAgentHost,
  LocalConnectResult,
  LocalHostStatus,
} from "./interface.js";

/**
 * The generated `parlor_host_*` commands, which reach the shared daemon on its control
 * socket (starting the bundled sidecar when none runs) and draw the pairing confirmation
 * as a native dialog outside the webview.
 */
export function tauriLocalAgentHost(
  load: () => Promise<TauriInvoke> = () => import("@tauri-apps/api/core"),
): CapabilityAdapter<LocalAgentHost> {
  return {
    platform: "tauri",
    available: () => hasNativeCommands(load),
    create: async () => {
      const { invoke } = await load();
      return {
        status: () => invoke<LocalHostStatus>("parlor_host_status"),
        connect: async ({ appOrigin, authorize, device }) => {
          const pairing = await invoke<HostPairing>("parlor_host_begin", { appOrigin });
          const code = await authorize(pairing);
          return invoke<LocalConnectResult>("parlor_host_finish", {
            appOrigin,
            code,
            device: device ?? null,
          });
        },
      };
    },
  };
}
