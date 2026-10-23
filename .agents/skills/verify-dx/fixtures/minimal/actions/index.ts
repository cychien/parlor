import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

export const registry = createRegistry({
  ping: defineAction({
    description: "Answer pong.",
    input: z.object({}),
    run: () => ({ pong: true }),
  }),
});
