import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { DeepLink } from "./interface.js";

export type { DeepLink, DeepLinkHandler } from "./interface.js";
export { capacitorDeepLink, type CapacitorAppModule } from "./capacitor.js";
export { tauriDeepLink, type TauriDeepLinkModule } from "./tauri.js";
export { webDeepLink } from "./web.js";

export const deepLink = defineCapability<DeepLink>({
  name: "deepLink",
  adapters: platformAdapters.deepLink,
});
