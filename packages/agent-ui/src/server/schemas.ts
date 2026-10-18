import { z } from "zod";

import type { ClientMessage } from "../protocol.js";

export const uiOpInputs = {
  screen: z.object({}),
};

const errorSchema = z.object({
  code: z.enum([
    "unknown_client",
    "ambiguous_client",
    "busy",
    "timeout",
    "outcome_unknown",
    "internal",
  ]),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const clientMessageSchema = z.union([
  z.object({
    type: z.literal("reply"),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("reply"),
    id: z.string().min(1),
    ok: z.literal(false),
    error: errorSchema,
  }),
  z.object({
    type: z.literal("presence"),
    focused: z.boolean(),
    visible: z.boolean(),
    platform: z.string(),
    buildId: z.string().optional(),
  }),
  z.object({ type: z.literal("leave") }),
]);

export function parseClientMessage(body: unknown): ClientMessage | undefined {
  const parsed = clientMessageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
