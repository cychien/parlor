import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { SessionStore } from "./interface.js";

export type { SessionStore } from "./interface.js";
export { capacitorSessionStore } from "./capacitor.js";
export { localSessionStore, SESSION_STORAGE_KEY, type StorageLike } from "./local.js";
export { tauriSessionStore } from "./tauri.js";
export { webSessionStore } from "./web.js";

export const sessionStore = defineCapability<SessionStore>({
  name: "sessionStore",
  adapters: platformAdapters.sessionStore,
});
