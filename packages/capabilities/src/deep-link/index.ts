import { defineCapability } from "../capability.js";
import type { DeepLink } from "./interface.js";
import { webDeepLink } from "./web.js";

export type { DeepLink, DeepLinkHandler } from "./interface.js";
export { webDeepLink } from "./web.js";

export const deepLink = defineCapability<DeepLink>({
  name: "deepLink",
  adapters: [webDeepLink()],
});
