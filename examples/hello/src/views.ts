import { defineAgentView } from "@parlor/client";
import * as z from "zod/mini";

export const task = defineAgentView({
  name: "task",
  description:
    "A task. The key is the task id that getTask, toggleTask and deleteTask take.",
  keyed: true,
  schema: z.object({ title: z.string(), done: z.boolean(), notes: z.string() }),
});

export const newTask = defineAgentView({
  name: "newTask",
  description:
    "The New task form on the home page. Fill it in for the user; they press Add themselves.",
  schema: z.object({ title: z.string(), notes: z.string() }),
  writable: true,
});

export const agentPanel = defineAgentView({
  name: "agentPanel",
  description:
    "The agent sidebar: the chat with the user's agent and the requests agents wait on the user to approve. Read-only, it only says whether the sidebar is open.",
  schema: z.object({ open: z.boolean() }),
});
