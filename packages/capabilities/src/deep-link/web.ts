import type { CapabilityAdapter } from "../capability.js";
import type { DeepLink } from "./interface.js";

export function webDeepLink(
  currentUrl: () => string | undefined = () => globalThis.location?.href,
): CapabilityAdapter<DeepLink> {
  return {
    platform: "web",
    available: () => currentUrl() !== undefined,
    create: () => ({
      onOpen: (handler) => {
        let cancelled = false;
        queueMicrotask(() => {
          const url = currentUrl();
          if (!cancelled && url) handler(url);
        });
        return () => {
          cancelled = true;
        };
      },
    }),
  };
}
