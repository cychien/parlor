import type { CapabilityAdapter } from "../capability.js";
import { hasNativeCommand } from "../device-key/native.js";
import type { TauriInvoke } from "../device-key/tauri.js";
import type { AuthBrowser } from "./interface.js";
import { schemeOf } from "./scheme.js";

const COMMAND = "parlor_auth_browser_open";

/** The generated `parlor_auth_browser_open` command, probed with a URL it refuses: ASWebAuthenticationSession on macOS. */
export function tauriAuthBrowser(
  load: () => Promise<TauriInvoke> = () => import("@tauri-apps/api/core"),
): CapabilityAdapter<AuthBrowser> {
  return {
    platform: "tauri",
    available: () => hasNativeCommand(load, COMMAND, { url: "", callbackScheme: "" }),
    create: async () => {
      const { invoke } = await load();
      return {
        open: async (url, callbackUrl) =>
          (await invoke<string | null>(COMMAND, {
            url,
            callbackScheme: schemeOf(callbackUrl),
          })) ?? undefined,
      };
    },
  };
}
