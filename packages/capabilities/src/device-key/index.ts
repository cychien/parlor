import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import { capacitorDeviceKey } from "./capacitor.js";
import type { DeviceKey } from "./interface.js";
import { tauriDeviceKey } from "./tauri.js";
import { webDeviceKey, type WebDeviceKeyApis } from "./web.js";

export {
  canonicalBytes,
  decodeBase64url,
  encodeBase64url,
  enrollmentBytes,
} from "./encoding.js";
export type {
  DeviceKey,
  DevicePublicKeys,
  DeviceSignature,
  PresenceEnrollment,
  PresencePublicKey,
  PresenceSignature,
} from "./interface.js";
export { capacitorDeviceKey, tauriDeviceKey, webDeviceKey, type WebDeviceKeyApis };

export const deviceKey = defineCapability<DeviceKey>({
  name: "deviceKey",
  adapters: platformAdapters.deviceKey,
});
