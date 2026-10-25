import { webAuthBrowser } from "../auth-browser/web.js";
import { webDeepLink } from "../deep-link/web.js";
import { webDeviceKey } from "../device-key/web.js";
import { webFiles } from "../files/web.js";
import { webLocalAgentHost } from "../local-agent-host/web.js";
import { webNotifications } from "../notifications/web.js";
import { webSessionStore } from "../session-store/web.js";
import type { PlatformAdapters } from "./types.js";

export const platformAdapters: PlatformAdapters = {
  notifications: [webNotifications()],
  deepLink: [webDeepLink()],
  sessionStore: [webSessionStore()],
  deviceKey: [webDeviceKey()],
  localAgentHost: [webLocalAgentHost()],
  files: [webFiles()],
  authBrowser: [webAuthBrowser()],
};
