import { useAgentConfirmations, useAgentView } from "@parlor/client/react";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { agentPanel } from "./views.js";

const AgentSidebar = lazy(() => import("./agent-sidebar.js"));

export function AgentPanel() {
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
    setOpen(!open);
    setEverOpened(true);
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
      {createPortal(
        <section
          id={regionId}
          ref={attach}
          className="agent-sidebar"
          aria-labelledby={titleId}
          hidden={!open}
        >
          <header>
            <h2 id={titleId}>Agent</h2>
            <button type="button" onClick={close}>
              Close
            </button>
          </header>
          {everOpened ? (
            <Suspense fallback={<p className="sidebar-note">Loading...</p>}>
              <AgentSidebar />
            </Suspense>
          ) : null}
        </section>,
        document.body,
      )}
    </>
  );
}
