import type { AgentConfirmation } from "@parlor/agent-ui/client";
import {
  type ComponentProps,
  createContext,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  use,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { useAgentConfirmations } from "./use-agent-confirmations.js";

interface ConfirmContext {
  readonly confirmation: AgentConfirmation;
  readonly labelId: string;
}

const ConfirmScope = createContext<ConfirmContext | undefined>(undefined);

interface ListContext {
  readonly register: (id: string, element: HTMLElement) => () => void;
  readonly releasingFocus: (id: string) => void;
}

const ListScope = createContext<ListContext | undefined>(undefined);

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): (() => void) | void {
  if (typeof ref === "function") return ref(value);
  if (ref) {
    ref.current = value;
    return () => {
      ref.current = null;
    };
  }
}

function useConfirm(part: string): ConfirmContext {
  const scope = use(ConfirmScope);
  if (!scope) throw new Error(`${part} must be rendered inside Chat.Confirm.`);
  return scope;
}

export interface ChatConfirmationsProps extends Omit<ComponentProps<"div">, "children"> {
  /** Shown while no agent request waits. */
  readonly empty?: ReactNode;
  readonly children: (confirmation: AgentConfirmation) => ReactNode;
}

/**
 * Lists the agent requests waiting for this user, newest last. Rendering it is what tells
 * the server this client can show a confirmation, so keep it mounted wherever the user can
 * answer. `data-pending` carries the count while any wait. When the card holding focus goes
 * away, focus moves to the next card, or to the list when none is left, so it never falls
 * out of an enclosing dialog.
 */
export function Confirmations({
  empty,
  children,
  ref,
  ...props
}: ChatConfirmationsProps) {
  const confirmations = useAgentConfirmations();
  const list = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const shownIds = useRef<readonly string[]>([]);
  const releasedId = useRef<string | undefined>(undefined);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      list.current = element;
      const detach = assignRef(ref, element);
      return () => {
        list.current = null;
        if (detach) detach();
        else assignRef(ref, null);
      };
    },
    [ref],
  );
  const scope = useMemo<ListContext>(
    () => ({
      register: (id, element) => {
        cards.current.set(id, element);
        return () => {
          cards.current.delete(id);
        };
      },
      releasingFocus: (id) => {
        releasedId.current = id;
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const released = releasedId.current;
    releasedId.current = undefined;
    const ids = confirmations.map((confirmation) => confirmation.id);
    const previousIds = shownIds.current;
    shownIds.current = ids;
    const listElement = list.current;
    if (released === undefined || !listElement) return;
    const active = document.activeElement;
    if (active && active !== document.body && listElement.contains(active)) return;
    const index = previousIds.indexOf(released);
    const nextId = ids[Math.min(index, ids.length - 1)];
    (nextId === undefined
      ? listElement
      : (cards.current.get(nextId) ?? listElement)
    ).focus();
  });

  return (
    <ListScope value={scope}>
      <div
        aria-live="polite"
        tabIndex={-1}
        {...props}
        ref={attach}
        data-pending={confirmations.length > 0 ? confirmations.length : undefined}
      >
        {confirmations.length === 0
          ? empty
          : confirmations.map((confirmation) => (
              <Fragment key={confirmation.id}>{children(confirmation)}</Fragment>
            ))}
      </div>
    </ListScope>
  );
}

export interface ChatConfirmProps extends ComponentProps<"div"> {
  readonly confirmation: AgentConfirmation;
}

/**
 * One request as a labelled group. Escape inside it declines, and stops there so an
 * enclosing dialog stays open. It never takes focus by itself, but it can hold it
 * (`tabIndex` -1) so `Chat.Confirmations` can keep focus in the list.
 */
export function Confirm({ confirmation, onKeyDown, ref, ...props }: ChatConfirmProps) {
  const labelId = useId();
  const list = use(ListScope);
  const group = useRef<HTMLDivElement | null>(null);
  const { id } = confirmation;
  useLayoutEffect(() => {
    const element = group.current;
    if (!list || !element) return;
    const unregister = list.register(id, element);
    return () => {
      if (element.contains(document.activeElement)) list.releasingFocus(id);
      unregister();
    };
  }, [list, id]);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      group.current = element;
      const detach = assignRef(ref, element);
      return () => {
        if (detach) detach();
        else assignRef(ref, null);
      };
    },
    [ref],
  );
  const decline = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    confirmation.decline();
  };
  return (
    <ConfirmScope value={{ confirmation, labelId }}>
      <div
        role="group"
        aria-labelledby={labelId}
        data-action={confirmation.action}
        tabIndex={-1}
        {...props}
        ref={attach}
        onKeyDown={decline}
      />
    </ConfirmScope>
  );
}

export function ConfirmLabel(props: Omit<ComponentProps<"p">, "id">) {
  const { labelId } = useConfirm("Chat.ConfirmLabel");
  return <p {...props} id={labelId} />;
}

export function Approve({ onClick, ...props }: ComponentProps<"button">) {
  const { confirmation } = useConfirm("Chat.Approve");
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) confirmation.approve();
      }}
    />
  );
}

export function Decline({ onClick, ...props }: ComponentProps<"button">) {
  const { confirmation } = useConfirm("Chat.Decline");
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) confirmation.decline();
      }}
    />
  );
}
