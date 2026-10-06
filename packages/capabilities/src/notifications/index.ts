import { defineCapability } from "../capability.js";
import type { Notifications } from "./interface.js";
import { webNotifications } from "./web.js";

export type {
  NotificationOptions,
  NotificationPermission,
  Notifications,
} from "./interface.js";
export { webNotifications } from "./web.js";

export const notifications = defineCapability<Notifications>({
  name: "notifications",
  adapters: [webNotifications()],
});
