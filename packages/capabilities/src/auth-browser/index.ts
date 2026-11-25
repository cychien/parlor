import { defineCapability } from "../capability.js";
import type { AuthBrowser } from "./interface.js";
import { webAuthBrowser } from "./web.js";

export type { AuthBrowser } from "./interface.js";
export { webAuthBrowser } from "./web.js";

export const authBrowser = defineCapability<AuthBrowser>({
  name: "authBrowser",
  adapters: [webAuthBrowser()],
});
