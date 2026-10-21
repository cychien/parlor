import type { CapabilityAdapter } from "../capability.js";
import type { DeviceKey } from "./interface.js";
import { hasNativeCommand, nativeDeviceKey, type NativePublicKeys } from "./native.js";

export interface TauriInvoke {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** The generated `parlor_device_key_public` and `parlor_device_key_sign` commands, probed with a sign request for a key that cannot exist. */
export function tauriDeviceKey(
  load: () => Promise<TauriInvoke> = () => import("@tauri-apps/api/core"),
): CapabilityAdapter<DeviceKey> {
  return {
    platform: "tauri",
    available: () =>
      hasNativeCommand(load, "parlor_device_key_sign", { keyId: "", payload: "" }),
    create: async () => {
      const { invoke } = await load();
      return nativeDeviceKey({
        publicKeys: (options) =>
          invoke<NativePublicKeys>("parlor_device_key_public", { ...options }),
        sign: (options) =>
          invoke<{ signature: string }>("parlor_device_key_sign", { ...options }),
      });
    },
  };
}
