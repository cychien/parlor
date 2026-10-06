import { detectPlatform, type Platform } from "./runtime.js";

export interface CapabilityAdapter<T> {
  readonly platform: Platform;
  available(): boolean | Promise<boolean>;
  create(): T;
}

export interface CapabilityDefinition<T> {
  readonly name: string;
  readonly adapters: readonly CapabilityAdapter<T>[];
}

export type CapabilityHandle<T> =
  | { readonly available: true; readonly platform: Platform; readonly api: T }
  | { readonly available: false; readonly reason: string };

export function defineCapability<T>(
  definition: CapabilityDefinition<T>,
): CapabilityDefinition<T> {
  return definition;
}

function candidates<T>(definition: CapabilityDefinition<T>, platform: Platform) {
  const native = definition.adapters.filter((a) => a.platform === platform);
  const baseline =
    platform === "web" ? [] : definition.adapters.filter((a) => a.platform === "web");
  return [...native, ...baseline];
}

export async function resolveCapability<T>(
  definition: CapabilityDefinition<T>,
  platform: Platform = detectPlatform(),
): Promise<CapabilityHandle<T>> {
  for (const adapter of candidates(definition, platform)) {
    if (await adapter.available()) {
      return { available: true, platform: adapter.platform, api: adapter.create() };
    }
  }
  return {
    available: false,
    reason: `Capability "${definition.name}" has no available adapter on ${platform}`,
  };
}
