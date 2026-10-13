import type { CapabilityAdapter } from "../capability.js";
import type { DeepLink } from "../deep-link/interface.js";
import type { Notifications } from "../notifications/interface.js";

export interface PlatformAdapters {
  readonly notifications: readonly CapabilityAdapter<Notifications>[];
  readonly deepLink: readonly CapabilityAdapter<DeepLink>[];
}
