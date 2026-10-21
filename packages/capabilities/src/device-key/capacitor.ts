import type { CapabilityAdapter } from "../capability.js";
import type { DeviceKey } from "./interface.js";

export function capacitorDeviceKey(): CapabilityAdapter<DeviceKey> {
  return {
    platform: "capacitor",
    available: () => false,
    create: () => {
      throw new Error("The mobile device key arrives with the mobile shell.");
    },
  };
}
