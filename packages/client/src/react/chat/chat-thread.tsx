import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

import { useChatState } from "./context.js";

export interface ChatThreadProps extends Omit<ComponentProps<"ol">, "children"> {
  readonly children: (item: ChatItem<AgentConfirmation>) => ReactNode;
  readonly empty?: ReactNode;
}

const NEAR_END_PX = 24;

const flag = (value: boolean) => (value ? "true" : "false");

/**
 * `role="log"`, one `<li data-kind data-streaming>` per item keyed by item id, so a
 * streamed reply keeps its row when its durable twin lands. Stays scrolled to the end
 * while the user is there and never steals focus; `data-status` mirrors the chat status.
 */
export function Thread({ children, empty, ref, onScroll, ...props }: ChatThreadProps) {
  const { items, status } = useChatState("Chat.Thread");
  const list = useRef<HTMLOListElement | null>(null);
  const atEnd = useRef(true);
  const attach = useCallback(
    (element: HTMLOListElement | null) => {
      list.current = element;
      if (typeof ref === "function") return ref(element);
      if (ref) {
        ref.current = element;
        return () => {
          ref.current = null;
        };
      }
    },
    [ref],
  );
  const track = (event: UIEvent<HTMLOListElement>) => {
    onScroll?.(event);
    const element = event.currentTarget;
    atEnd.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_END_PX;
  };
  useLayoutEffect(() => {
    const element = list.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <Fragment>
      <ol role="log" {...props} ref={attach} onScroll={track} data-status={status}>
        {items.map((item) => (
          <li
            key={item.id}
            data-item-id={item.id}
            data-kind={item.kind}
            data-streaming={"streaming" in item ? flag(item.streaming) : undefined}
            data-interrupted={
              item.kind === "reply" || item.kind === "reasoning"
                ? flag(item.interrupted)
                : undefined
            }
          >
            {children(item)}
          </li>
        ))}
      </ol>
      {items.length === 0 ? empty : null}
    </Fragment>
  );
}
