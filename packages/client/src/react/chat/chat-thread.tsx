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

import { useChatRuntime, useChatState } from "./context.js";

export interface ChatThreadProps extends Omit<ComponentProps<"ol">, "children"> {
  readonly children: (item: ChatItem<AgentConfirmation>) => ReactNode;
  readonly empty?: ReactNode;
  /** The first row while the thread has earlier items, such as a `Chat.LoadOlder`. */
  readonly older?: ReactNode;
}

const NEAR_END_PX = 24;

const flag = (value: boolean) => (value ? "true" : "false");

/**
 * `role="log"`, one `<li data-kind data-streaming>` per item keyed by item id, so a
 * streamed reply keeps its row when its durable twin lands. Stays scrolled to the end
 * while the user is there and never steals focus; `data-status` mirrors the chat status.
 */
export function Thread({
  children,
  empty,
  older,
  ref,
  onScroll,
  ...props
}: ChatThreadProps) {
  const { items, status, hasOlder } = useChatState("Chat.Thread");
  const list = useRef<HTMLOListElement | null>(null);
  const atEnd = useRef(true);
  const anchor = useRef<{ readonly first?: string | undefined; readonly height: number }>(
    {
      height: 0,
    },
  );
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
    if (!element) return;
    const first = items[0]?.id;
    const before = anchor.current;
    if (atEnd.current) element.scrollTop = element.scrollHeight;
    else if (
      before.first !== undefined &&
      first !== before.first &&
      items.some((item) => item.id === before.first)
    ) {
      element.scrollTop += element.scrollHeight - before.height;
    }
    anchor.current = { first, height: element.scrollHeight };
  });

  return (
    <Fragment>
      <ol role="log" {...props} ref={attach} onScroll={track} data-status={status}>
        {hasOlder && older !== undefined ? <li data-kind="older">{older}</li> : null}
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

/** `type="button"`; rendered only while the thread has earlier items, which it reads. */
export function LoadOlder({ children, onClick, ...props }: ComponentProps<"button">) {
  const runtime = useChatRuntime("Chat.LoadOlder");
  const { hasOlder, loadingOlder } = useChatState("Chat.LoadOlder");
  if (!hasOlder) return null;
  return (
    <button
      type="button"
      disabled={loadingOlder}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          runtime.loadOlder().catch((error: unknown) => {
            console.error("[parlor] The chat could not do that:", error);
          });
        }
      }}
    >
      {children ?? (loadingOlder ? "Loading…" : "Show earlier messages")}
    </button>
  );
}
