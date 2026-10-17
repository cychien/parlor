import { defineAgentView } from "@parlor/client";
import * as z from "zod/mini";

export const task = defineAgentView({
  name: "task",
  description: "A task. The key is the task id that getTask and toggleTask take.",
  keyed: true,
  schema: z.object({ title: z.string(), done: z.boolean() }),
});
