import { useAgentConfirmations, useAgentView } from "@parlor/client/react";
import { useHydrated } from "@tanstack/react-router";
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

export function AgentPanel() {
  const regionId = useId();
  const titleId = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const region = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  const pending = useAgentConfirmations().length;
  const hydrated = useHydrated();
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
        className="agent-button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={pending > 0 ? `Agent, ${pending} pending` : undefined}
        data-pending={pending > 0 ? pending : undefined}
        onClick={toggle}
      >
        Agent
        {pending > 0 ? <span className="badge">{pending}</span> : null}
      </button>
      {hydrated
        ? createPortal(
            <section
              id={regionId}
              ref={attach}
              className="agent-sidebar"
              aria-labelledby={titleId}
              hidden={!open}
            >
              <header>
                <h2 id={titleId}>Agent</h2>
                <div className="header-actions">
                  <span ref={setHeaderActions} className="header-slot" />
                  <button type="button" onClick={close}>
                    Close
                  </button>
                </div>
              </header>
              <Suspense fallback={<p className="sidebar-note">Loading...</p>}>
                {everOpened ? <AgentSidebar headerActions={headerActions} /> : null}
              </Suspense>
            </section>,
            document.body,
          )
        : null}
    </>
  );
}
