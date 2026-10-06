import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { DeepLink } from "./interface.js";

export interface CapacitorAppModule {
  App: {
    getLaunchUrl(): Promise<{ url: string } | undefined>;
    addListener(
      event: "appUrlOpen",
      handler: (event: { url: string }) => void,
    ): Promise<{ remove(): Promise<void> }>;
  };
}

export function capacitorDeepLink(
  load: () => Promise<CapacitorAppModule> = () => import("@capacitor/app"),
): CapabilityAdapter<DeepLink> {
  return {
    platform: "capacitor",
    available: () => detectPlatform() === "capacitor",
    create: async () => {
      const { App } = await load();
      return {
        onOpen: (handler) => {
          let cancelled = false;
          void App.getLaunchUrl().then((launch) => {
            if (!cancelled && launch?.url) handler(launch.url);
          });
          const listener = App.addListener("appUrlOpen", ({ url }) => {
            if (!cancelled) handler(url);
          });
          return () => {
            cancelled = true;
            void listener.then((handle) => handle.remove());
          };
        },
      };
    },
  };
}
