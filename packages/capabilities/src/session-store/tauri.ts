import type { CapabilityAdapter } from "../capability.js";
import { hasNativeCommands } from "../device-key/native.js";
import type { TauriInvoke } from "../device-key/tauri.js";
import { detectPlatform } from "../runtime.js";
import type { SessionStore } from "./interface.js";
import { keychainSessionStore } from "./keychain.js";
import { localSessionStore, type StorageLike } from "./local.js";

/**
 * The macOS Keychain through the generated `parlor_session_*` commands; the webview's own
 * storage in a shell built without `desktop.agentHost`, which has no such commands.
 */
export function tauriSessionStore(
  storage: () => StorageLike = () => globalThis.localStorage,
  load: () => Promise<TauriInvoke> = () => import("@tauri-apps/api/core"),
): CapabilityAdapter<SessionStore> {
  return {
    platform: "tauri",
    available: () => detectPlatform() === "tauri",
    create: async () => {
      if (!(await hasNativeCommands(load))) return localSessionStore(storage());
      const { invoke } = await load();
      return keychainSessionStore(
        {
          get: async () =>
            (await invoke<string | null>("parlor_session_get")) ?? undefined,
          set: (token) => invoke<void>("parlor_session_set", { token: token ?? null }),
        },
        storage(),
      );
    },
  };
}
