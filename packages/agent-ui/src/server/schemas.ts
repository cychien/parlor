import { z } from "zod";

import type { ClientMessage } from "../protocol.js";

export const uiOpInputs = {
  screen: z.object({}),
  navigate: z.object({
    to: z.string(),
    params: z
      .record(z.string(), z.string())
      .optional()
      .describe('Values for the $params in the path, e.g. { "taskId": "..." }.'),
    search: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Search params for the page."),
    replace: z
      .boolean()
      .optional()
      .describe("Replace the current history entry instead of pushing one."),
  }),
};

const errorSchema = z.object({
  code: z.enum([
    "unknown_route",
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
