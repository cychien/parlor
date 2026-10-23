import { useAgentConfirmations, useAgentView } from "@parlor/client/react";
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { sidebarView } from "./sidebar-view.js";
import { agentPanel } from "./views.js";

const AgentSidebar = lazy(() => import("./agent-sidebar.js"));

export function AgentButton() {
  const regionId = useId();
  const titleId = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const region = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const pending = useAgentConfirmations().length;
  const { ref } = useAgentView(agentPanel, { get: () => ({ open }) });
  const attach = useCallback(
    (element: HTMLElement | null) => {
      region.current = element;
      ref(element);
    },
    [ref],
  );

  useEffect(() => {
    if (open) region.current?.querySelector("textarea")?.focus();
  }, [open]);
  useEffect(() => {
    sidebarView.set({ open });
    return () => sidebarView.set({ open: false });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const focus = document.activeElement;
      const inside =
        focus === document.body ||
        focus === button.current ||
        region.current?.contains(focus);
      if (!inside) return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);

  const toggle = () => {
    startTransition(() => {
      setOpen(!open);
      setEverOpened(true);
    });
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={pending > 0 ? `Agent, ${pending} pending` : undefined}
        onClick={toggle}
        className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 aria-expanded:bg-zinc-900 aria-expanded:text-white"
      >
        Agent
        {pending > 0 ? (
          <span className="rounded-full bg-amber-500 px-1.5 text-xs text-white">
            {pending}
          </span>
        ) : null}
      </button>
      {createPortal(
        <section
          id={regionId}
          ref={attach}
          aria-labelledby={titleId}
          hidden={!open}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <h2 id={titleId} className="font-semibold">
              Agent
            </h2>
            <button
              type="button"
              onClick={close}
              className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
            >
              Close
            </button>
          </header>
          <Suspense fallback={<p className="p-4 text-sm text-zinc-500">Loading...</p>}>
            {everOpened ? <AgentSidebar /> : null}
          </Suspense>
        </section>,
        document.body,
      )}
    </>
  );
}
