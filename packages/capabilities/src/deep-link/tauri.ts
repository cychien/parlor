import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { DeepLink } from "./interface.js";

export interface TauriDeepLinkModule {
  getCurrent(): Promise<string[] | null>;
  onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>;
}

export function tauriDeepLink(
  load: () => Promise<TauriDeepLinkModule> = () => import("@tauri-apps/plugin-deep-link"),
): CapabilityAdapter<DeepLink> {
  return {
    platform: "tauri",
    available: () => detectPlatform() === "tauri",
    create: async () => {
      const plugin = await load();
      return {
        onOpen: (handler) => {
          let cancelled = false;
          const deliver = (urls: string[] | null) => {
            if (cancelled) return;
            for (const url of urls ?? []) handler(url);
          };
          void plugin.getCurrent().then(deliver);
          const unlisten = plugin.onOpenUrl(deliver);
          return () => {
            cancelled = true;
            void unlisten.then((stop) => stop());
          };
        },
      };
    },
  };
}
