import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { z } from "zod";

let count = 0;

export const registry = createRegistry({
  hello: defineAction({
    description: "Return a friendly greeting.",
    input: z.object({ name: z.string().min(1).default("world") }),
    run: ({ name }) => ({ message: `Hello, ${name}!` }),
  }),
  getCount: defineAction({
    description: "Read the shared counter.",
    input: z.object({}),
    reads: ["counter"],
    run: () => ({ count }),
  }),
  increment: defineAction({
    description: "Increase the shared counter by an amount.",
    input: z.object({ by: z.number().int().positive().default(1) }),
    writes: ["counter"],
    run: ({ by }) => {
      count += by;
      return { count };
    },
  }),
});
