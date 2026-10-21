import type { CapabilityAdapter } from "../capability.js";
import type { LocalAgentHost } from "./interface.js";

/** A phone cannot spawn an agent process. */
export function capacitorLocalAgentHost(): CapabilityAdapter<LocalAgentHost> {
  return {
    platform: "capacitor",
    available: () => false,
    create: () => {
      throw new Error("Agents cannot run on a phone; connect a computer instead.");
    },
  };
}
