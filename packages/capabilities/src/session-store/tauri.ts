import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { SessionStore } from "./interface.js";
import { localSessionStore, type StorageLike } from "./local.js";

export function tauriSessionStore(
  storage: () => StorageLike = () => globalThis.localStorage,
): CapabilityAdapter<SessionStore> {
  return {
    platform: "tauri",
    available: () => detectPlatform() === "tauri",
    create: () => localSessionStore(storage()),
  };
}
