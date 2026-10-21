import type { CapabilityAdapter } from "../capability.js";
import type { TauriInvoke } from "../device-key/tauri.js";
import { detectPlatform } from "../runtime.js";
import type { LocalAgentHost } from "./interface.js";

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
    available: async () => {
      if (detectPlatform() !== "tauri") return false;
      // TODO: invoke<boolean>("parlor_host_bundled"), false on any error.
      void load;
      throw new Error("not implemented");
    },
    create: async () => {
      // TODO: status -> invoke("parlor_host_status"); connect -> invoke("parlor_host_begin",
      //   { appOrigin }) gives a HostPairing, await input.authorize(pairing), then
      //   invoke("parlor_host_finish", { code }), which resolves after the native dialog.
      void (await load());
      throw new Error("not implemented");
    },
  };
}
