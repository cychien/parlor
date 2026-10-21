import type { CapabilityAdapter } from "../capability.js";
import type { LocalAgentHost } from "./interface.js";

/** A web page never reaches a local process: the host has no listener to reach. */
export function webLocalAgentHost(): CapabilityAdapter<LocalAgentHost> {
  return {
    platform: "web",
    available: () => false,
    create: () => {
      throw new Error("Parlor Host is not reachable from a web page.");
    },
  };
}
