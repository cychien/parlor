import type { CapabilityAdapter } from "../capability.js";
import type { AuthBrowser } from "./interface.js";

/** The page itself goes to the provider. */
export function webAuthBrowser(
  location: () => Pick<Location, "assign"> | undefined = () => globalThis.location,
): CapabilityAdapter<AuthBrowser> {
  return {
    available: () => location() !== undefined,
    create: () => ({
      open: (url) => {
        location()?.assign(url);
        return new Promise<never>(() => {});
      },
    }),
  };
}
