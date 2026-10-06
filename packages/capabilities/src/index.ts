export type { PlatformAdapters } from "./adapters/types.js";
export {
  type CapabilityAdapter,
  type CapabilityDefinition,
  type CapabilityHandle,
  defineCapability,
  resolveCapability,
} from "./capability.js";
export * from "./deep-link/index.js";
export * from "./notifications/index.js";
export { detectPlatform, type Platform } from "./runtime.js";
