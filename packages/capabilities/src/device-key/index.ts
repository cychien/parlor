import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { DeviceKey } from "./interface.js";

export { capacitorDeviceKey, type CapacitorDeviceKeyModule } from "./capacitor.js";

export type {
  DeviceKey,
  DevicePublicKeys,
  DeviceSignature,
  PresenceEnrollment,
  PresencePublicKey,
  PresenceSignature,
} from "./interface.js";
export { tauriDeviceKey, type TauriInvoke } from "./tauri.js";
export { webDeviceKey, type WebDeviceKeyApis } from "./web.js";

export const deviceKey = defineCapability<DeviceKey>({
  name: "deviceKey",
  adapters: platformAdapters.deviceKey,
});
