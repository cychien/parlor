import { webDeepLink } from "../deep-link/web.js";
import { webNotifications } from "../notifications/web.js";
import { webSessionStore } from "../session-store/web.js";
import type { PlatformAdapters } from "./types.js";

export const platformAdapters: PlatformAdapters = {
  notifications: [webNotifications()],
  deepLink: [webDeepLink()],
  sessionStore: [webSessionStore()],
};
