import { z } from "zod";

import { type ClientMessage, UI_ERROR_CODES } from "../protocol.js";

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
  set: z.object({
    view: z.string().describe("A writable view's name, as listed."),
    key: z.string().optional().describe("The item's key, for a keyed view."),
    value: z
      .record(z.string(), z.unknown())
      .describe("The fields to write; others keep their current value."),
  }),
  highlight: z.object({
    view: z.string().describe("A view's name, as ui_screen reports it."),
    key: z.string().optional().describe("The item's key, for a keyed view."),
    field: z
      .string()
      .optional()
      .describe("A field inside the view to focus, by its input name."),
  }),
};

const errorSchema = z.object({
  code: z.enum(UI_ERROR_CODES),
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
    ops: z.array(z.string()).optional(),
    canConfirm: z.boolean().optional(),
  }),
  z.object({ type: z.literal("leave") }),
  z.object({ type: z.literal("answer"), id: z.string().min(1), approve: z.boolean() }),
]);

export function parseClientMessage(body: unknown): ClientMessage | undefined {
  const parsed = clientMessageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
