import type { CapabilityAdapter } from "../capability.js";
import type { DeepLink } from "../deep-link/interface.js";
import type { DeviceKey } from "../device-key/interface.js";
import type { Notifications } from "../notifications/interface.js";
import type { SessionStore } from "../session-store/interface.js";

export interface PlatformAdapters {
  readonly notifications: readonly CapabilityAdapter<Notifications>[];
  readonly deepLink: readonly CapabilityAdapter<DeepLink>[];
  readonly sessionStore: readonly CapabilityAdapter<SessionStore>[];
  readonly deviceKey: readonly CapabilityAdapter<DeviceKey>[];
}
