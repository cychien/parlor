import { z } from "zod";

import { type ClientMessage, MAX_WATCHED_THREADS, UI_ERROR_CODES } from "../protocol.js";

export { uiOpInputs } from "../op-inputs.js";

const errorSchema = z.object({
  code: z.enum(UI_ERROR_CODES),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const watchingSchema = z
  .array(z.unknown())
  .transform((ids) =>
    ids
      .filter((id): id is string => typeof id === "string" && id !== "")
      .slice(0, MAX_WATCHED_THREADS),
  )
  .optional()
  .catch(undefined);

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
    ops: z.array(z.string()).optional(),
    canConfirm: z.boolean().optional(),
    watching: watchingSchema,
  }),
  z.object({ type: z.literal("leave") }),
  z.object({ type: z.literal("answer"), id: z.string().min(1), approve: z.boolean() }),
]);

export function parseClientMessage(body: unknown): ClientMessage | undefined {
  const parsed = clientMessageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
