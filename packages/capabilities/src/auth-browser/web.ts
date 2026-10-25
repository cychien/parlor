import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { AuthBrowser } from "./interface.js";

/** The page itself goes to the provider; a native shell's webview cannot, so it is web only. */
export function webAuthBrowser(
  location: () => Pick<Location, "assign"> | undefined = () => globalThis.location,
): CapabilityAdapter<AuthBrowser> {
  return {
    platform: "web",
    available: () => detectPlatform() === "web" && location() !== undefined,
    create: () => ({
      open: (url) => {
        location()?.assign(url);
        return new Promise<never>(() => {});
      },
    }),
  };
}
