import { capacitorDeepLink } from "../deep-link/capacitor.js";
import { webDeepLink } from "../deep-link/web.js";
import { capacitorNotifications } from "../notifications/capacitor.js";
import { webNotifications } from "../notifications/web.js";
import type { PlatformAdapters } from "./types.js";

export const platformAdapters: PlatformAdapters = {
  notifications: [capacitorNotifications(), webNotifications()],
  deepLink: [capacitorDeepLink(), webDeepLink()],
};
