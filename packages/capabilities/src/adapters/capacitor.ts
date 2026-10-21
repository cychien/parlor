import { capacitorDeepLink } from "../deep-link/capacitor.js";
import { webDeepLink } from "../deep-link/web.js";
import { capacitorDeviceKey } from "../device-key/capacitor.js";
import { webDeviceKey } from "../device-key/web.js";
import { capacitorNotifications } from "../notifications/capacitor.js";
import { webNotifications } from "../notifications/web.js";
import { capacitorSessionStore } from "../session-store/capacitor.js";
import { webSessionStore } from "../session-store/web.js";
import type { PlatformAdapters } from "./types.js";

export const platformAdapters: PlatformAdapters = {
  notifications: [capacitorNotifications(), webNotifications()],
  deepLink: [capacitorDeepLink(), webDeepLink()],
  sessionStore: [capacitorSessionStore(), webSessionStore()],
  deviceKey: [capacitorDeviceKey(), webDeviceKey()],
};
