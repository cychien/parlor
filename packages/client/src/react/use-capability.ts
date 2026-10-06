import {
  type CapabilityDefinition,
  type CapabilityHandle,
  resolveCapability,
} from "@parlor/capabilities";
import { useEffect, useState } from "react";

const RESOLVING = { available: false, reason: "resolving" } as const;

export type CapabilityState<T> = CapabilityHandle<T> & { readonly resolving?: boolean };

export function useCapability<T>(
  definition: CapabilityDefinition<T>,
): CapabilityState<T> {
  const [state, setState] = useState<CapabilityState<T>>({
    ...RESOLVING,
    resolving: true,
  });
  useEffect(() => {
    let active = true;
    void resolveCapability(definition).then((handle) => {
      if (active) setState(handle);
    });
    return () => {
      active = false;
    };
  }, [definition]);
  return state;
}
