import type { CapabilityAdapter } from "../capability.js";
import { hasIosPlugin } from "../device-key/native.js";
import type { AuthBrowser } from "./interface.js";
import { schemeOf } from "./scheme.js";

/** The `ParlorAuthBrowser` native plugin: ASWebAuthenticationSession on iOS. */
export interface CapacitorAuthBrowserModule {
  ParlorAuthBrowser: {
    open(options: { url: string; callbackScheme: string }): Promise<{ url?: string }>;
  };
}

export function capacitorAuthBrowser(
  load: () => Promise<CapacitorAuthBrowserModule> = () =>
    import("@parlor/capacitor-device-key"),
): CapabilityAdapter<AuthBrowser> {
  return {
    platform: "capacitor",
    available: () => hasIosPlugin(),
    create: async () => {
      const { ParlorAuthBrowser } = await load();
      return {
        open: async (url, callbackUrl) =>
          (await ParlorAuthBrowser.open({ url, callbackScheme: schemeOf(callbackUrl) }))
            .url,
      };
    },
  };
}
