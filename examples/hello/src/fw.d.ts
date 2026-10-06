import type { ActionsOf } from "@fw/core/registry";

import type { registry } from "../actions/index.js";

declare module "@fw/client" {
  interface Register {
    actions: ActionsOf<typeof registry>;
  }
}
