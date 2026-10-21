import { tauriDeepLink } from "../deep-link/tauri.js";
import { webDeepLink } from "../deep-link/web.js";
import { tauriDeviceKey } from "../device-key/tauri.js";
import { webDeviceKey } from "../device-key/web.js";
import { tauriNotifications } from "../notifications/tauri.js";
import { webNotifications } from "../notifications/web.js";
import { tauriSessionStore } from "../session-store/tauri.js";
import { webSessionStore } from "../session-store/web.js";
import type { PlatformAdapters } from "./types.js";

export const platformAdapters: PlatformAdapters = {
  notifications: [tauriNotifications(), webNotifications()],
  deepLink: [tauriDeepLink(), webDeepLink()],
  sessionStore: [tauriSessionStore(), webSessionStore()],
  deviceKey: [tauriDeviceKey(), webDeviceKey()],
};
