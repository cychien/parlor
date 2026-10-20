import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { DeviceKey } from "./interface.js";

export interface TauriInvoke {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** The generated `parlor_device_key_public` and `parlor_device_key_sign` commands. */
export function tauriDeviceKey(
  load: () => Promise<TauriInvoke> = () => import("@tauri-apps/api/core"),
): CapabilityAdapter<DeviceKey> {
  return {
    platform: "tauri",
    available: () => detectPlatform() === "tauri",
    create: async () => {
      // TODO: Keychain and Secure Enclave keys; the presence key uses LAContext with
      //   .userPresence, so macOS shows Touch ID.
      void (await load());
      throw new Error("not implemented");
    },
  };
}
