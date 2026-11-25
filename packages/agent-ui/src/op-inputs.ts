import { z } from "zod";

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
      .describe("Search params for the page, as its entry in the list names them."),
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
