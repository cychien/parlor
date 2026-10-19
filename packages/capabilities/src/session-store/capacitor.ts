import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { SessionStore } from "./interface.js";
import { localSessionStore, type StorageLike } from "./local.js";

export function capacitorSessionStore(
  storage: () => StorageLike = () => globalThis.localStorage,
): CapabilityAdapter<SessionStore> {
  return {
    platform: "capacitor",
    available: () => detectPlatform() === "capacitor",
    create: () => localSessionStore(storage()),
  };
}
