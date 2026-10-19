import type { CapabilityAdapter } from "../capability.js";
import type { SessionStore } from "./interface.js";

/** Never available: the browser carries the session in an HttpOnly cookie. */
export function webSessionStore(): CapabilityAdapter<SessionStore> {
  return {
    platform: "web",
    available: () => false,
    create: () => {
      throw new Error("The web keeps its session in a cookie.");
    },
  };
}
