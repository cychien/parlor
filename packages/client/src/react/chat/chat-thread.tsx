import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import type { ComponentProps, ReactNode } from "react";

export interface ChatThreadProps extends Omit<ComponentProps<"ol">, "children"> {
  readonly children: (item: ChatItem<AgentConfirmation>) => ReactNode;
  readonly empty?: ReactNode;
}

/**
 * `role="log"`, one `<li data-kind data-streaming>` per item keyed by item id, so a
 * streamed reply keeps its row when its durable twin lands. Stays scrolled to the end
 * while the user is there and never steals focus; `data-status` mirrors the chat status.
 */
export function Thread(props: ChatThreadProps): ReactNode {
  void props;
  throw new Error("not implemented");
}
