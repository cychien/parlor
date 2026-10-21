import type { CapabilityAdapter } from "../capability.js";
import type { DeviceKey } from "./interface.js";

export function tauriDeviceKey(): CapabilityAdapter<DeviceKey> {
  return {
    platform: "tauri",
    available: () => false,
    create: () => {
      throw new Error("The desktop device key arrives with the desktop shell.");
    },
  };
}
