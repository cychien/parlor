import { tauriDeepLink } from "../deep-link/tauri.js";
import { webDeepLink } from "../deep-link/web.js";
import { tauriNotifications } from "../notifications/tauri.js";
import { webNotifications } from "../notifications/web.js";
import type { PlatformAdapters } from "./types.js";

export const platformAdapters: PlatformAdapters = {
  notifications: [tauriNotifications(), webNotifications()],
  deepLink: [tauriDeepLink(), webDeepLink()],
};
