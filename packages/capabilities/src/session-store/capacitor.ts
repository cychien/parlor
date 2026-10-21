import type { CapabilityAdapter } from "../capability.js";
import { hasIosPlugin } from "../device-key/native.js";
import { detectPlatform } from "../runtime.js";
import type { SessionStore } from "./interface.js";
import { keychainSessionStore } from "./keychain.js";
import { localSessionStore, type StorageLike } from "./local.js";

/** The `ParlorSessionStore` native plugin: the iOS Keychain. */
export interface CapacitorSessionModule {
  ParlorSessionStore: {
    get(): Promise<{ value?: string }>;
    set(options: { value?: string }): Promise<void>;
  };
}

/** The iOS Keychain; the webview's own storage where the plugin has no implementation. */
export function capacitorSessionStore(
  storage: () => StorageLike = () => globalThis.localStorage,
  load: () => Promise<CapacitorSessionModule> = () =>
    import("@parlor/capacitor-device-key"),
): CapabilityAdapter<SessionStore> {
  return {
    platform: "capacitor",
    available: () => detectPlatform() === "capacitor",
    create: async () => {
      if (!hasIosPlugin()) return localSessionStore(storage());
      const { ParlorSessionStore } = await load();
      return keychainSessionStore(
        {
          get: async () => (await ParlorSessionStore.get()).value,
          set: (token) =>
            ParlorSessionStore.set(token === undefined ? {} : { value: token }),
        },
        storage(),
      );
    },
  };
}
