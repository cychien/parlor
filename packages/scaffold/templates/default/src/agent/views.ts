import { defineAgentView } from "@parlor/client";
import * as z from "zod/mini";

export const agentPanel = defineAgentView({
  name: "agentPanel",
  description:
    "The agent sidebar: the chat with the user's agent and the requests waiting for the user's approval. Read-only; it says whether the sidebar is open.",
  schema: z.object({ open: z.boolean() }),
});
