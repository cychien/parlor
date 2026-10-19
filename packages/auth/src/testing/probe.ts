import { ActionError, defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import type { ServerPlugin } from "@parlor/server";
import { z } from "zod";

/** Stands in for a chat host action: callable by a host principal and nobody else. */
export const probePlugin: ServerPlugin = {
  name: "probe",
  setup: () => ({
    actions: createRegistry({
      hostHello: defineAction({
        description: "A host says hello.",
        input: z.object({}),
        run: (_input, ctx) => {
          if (ctx.principal.kind !== "host") {
            throw new ActionError("forbidden", "Only a host says hello.");
          }
          return {
            accepted: true,
            protocol: 1,
            hostId: ctx.principal.hostId,
            grantId: ctx.principal.grantId,
          };
        },
      }),
    }),
  }),
};
