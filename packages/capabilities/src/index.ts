export type { PlatformAdapters } from "./adapters/types.js";
export {
  type CapabilityAdapter,
  type CapabilityDefinition,
  type CapabilityHandle,
  defineCapability,
  resolveCapability,
} from "./capability.js";
export * from "./deep-link/index.js";
export * from "./device-key/index.js";
export {
  capacitorLocalAgentHost,
  localAgentHost,
  tauriLocalAgentHost,
  webLocalAgentHost,
} from "./local-agent-host/index.js";
export type {
  HostPairing,
  LocalAgentHost,
  LocalConnectInput,
  LocalConnectResult,
  LocalHostStatus,
  PairingDevice,
  PairingPresenceKey,
} from "./local-agent-host/interface.js";
export * from "./files/index.js";
export * from "./notifications/index.js";
export { detectPlatform, type Platform } from "./runtime.js";
export * from "./session-store/index.js";
