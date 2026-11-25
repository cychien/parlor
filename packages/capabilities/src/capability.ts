export interface CapabilityAdapter<T> {
  available(): boolean | Promise<boolean>;
  create(): T | Promise<T>;
}

export interface CapabilityDefinition<T> {
  readonly name: string;
  readonly adapters: readonly CapabilityAdapter<T>[];
}

export type CapabilityHandle<T> =
  | { readonly available: true; readonly api: T }
  | { readonly available: false; readonly reason: string };

export function defineCapability<T>(
  definition: CapabilityDefinition<T>,
): CapabilityDefinition<T> {
  return definition;
}

/** The first adapter this browser can run wins. */
export async function resolveCapability<T>(
  definition: CapabilityDefinition<T>,
): Promise<CapabilityHandle<T>> {
  for (const adapter of definition.adapters) {
    if (await adapter.available())
      return { available: true, api: await adapter.create() };
  }
  return {
    available: false,
    reason: `Capability "${definition.name}" is not available in this browser`,
  };
}
