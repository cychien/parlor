import { defineChatUi } from "@parlor/chat";
import { z } from "zod";

/** What the agent may show in the chat with `chat_show`; the sidebar renders each with its component. */
export const chatUi = defineChatUi({
  Card: {
    description: "A titled group of other elements, such as a few stats side by side.",
    props: z.object({ title: z.string() }),
    children: true,
  },
  Stat: {
    description: "One number with its label, such as open tasks.",
    props: z.object({ label: z.string(), value: z.number() }),
  },
  Bars: {
    description:
      "Labelled counts as horizontal bars, longest first, to compare a few groups.",
    props: z.object({
      rows: z
        .array(z.object({ label: z.string(), value: z.number().nonnegative() }))
        .min(1)
        .max(12),
    }),
  },
});
