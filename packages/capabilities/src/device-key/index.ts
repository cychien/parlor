import { defineCapability } from "../capability.js";
import type { DeviceKey } from "./interface.js";
import { webDeviceKey } from "./web.js";

export { PresenceSetupCancelled } from "./interface.js";
export type {
  DeviceKey,
  DevicePublicKeys,
  DeviceSignature,
  PresenceEnrollment,
  PresencePublicKey,
  PresenceSignature,
} from "./interface.js";
export { webDeviceKey, type WebDeviceKeyApis } from "./web.js";

export const deviceKey = defineCapability<DeviceKey>({
  name: "deviceKey",
  adapters: [webDeviceKey()],
});
