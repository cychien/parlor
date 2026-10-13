import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { Notifications } from "./interface.js";

export type {
  NotificationHandle,
  NotificationOptions,
  NotificationPermission,
  Notifications,
} from "./interface.js";
export { capacitorNotifications, type CapacitorNotificationModule } from "./capacitor.js";
export { tauriNotifications, type TauriNotificationModule } from "./tauri.js";
export { webNotifications } from "./web.js";

export const notifications = defineCapability<Notifications>({
  name: "notifications",
  adapters: platformAdapters.notifications,
});
