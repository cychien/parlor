import type { ActionsOf } from "@parlor/core/registry";

import type { registry } from "../actions/index.js";

declare module "@parlor/client" {
  interface Register {
    actions: ActionsOf<typeof registry>;
  }
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    readonly description?: string | undefined;
  }
}
