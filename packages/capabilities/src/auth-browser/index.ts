import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { AuthBrowser } from "./interface.js";

export type { AuthBrowser } from "./interface.js";
export { capacitorAuthBrowser, type CapacitorAuthBrowserModule } from "./capacitor.js";
export { tauriAuthBrowser } from "./tauri.js";
export { webAuthBrowser } from "./web.js";

export const authBrowser = defineCapability<AuthBrowser>({
  name: "authBrowser",
  adapters: platformAdapters.authBrowser,
});
