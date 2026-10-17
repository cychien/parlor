import type { ScreenSnapshot } from "@parlor/agent-ui";
import type { AgentUiClient } from "@parlor/agent-ui/client";

declare global {
  interface Window {
    __parlor?:
      | { readonly clientId: string; screen(): Promise<ScreenSnapshot> }
      | undefined;
  }
}

const TOGGLE_HINT = "Alt+Shift+A";
const MAX_LOG = 10;

function overlay(agentUi: AgentUiClient, clientId: string): () => void {
  const panel = document.createElement("aside");
  panel.setAttribute("aria-label", "Parlor agent UI");
  panel.hidden = true;
  Object.assign(panel.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    width: "min(420px, calc(100vw - 24px))",
    maxHeight: "60vh",
    overflow: "auto",
    zIndex: "2147483647",
    background: "#111",
    color: "#eee",
    font: "12px/1.4 ui-monospace, monospace",
    padding: "12px",
    borderRadius: "8px",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.3)",
  });
  const header = document.createElement("div");
  const log = document.createElement("ol");
  log.style.margin = "8px 0";
  log.style.paddingLeft = "28px";
  const snapshot = document.createElement("pre");
  snapshot.style.margin = "0";
  snapshot.style.whiteSpace = "pre-wrap";
  panel.append(header, log, snapshot);
  document.body.append(panel);

  const entries: string[] = [];
  let lastStarted: number | undefined;
  const render = () => {
    header.textContent = `client ${clientId} (${TOGGLE_HINT} to close)`;
    log.replaceChildren(
      ...entries.map((text) =>
        Object.assign(document.createElement("li"), { textContent: text }),
      ),
    );
    void agentUi.screen().then((screen) => {
      snapshot.textContent = JSON.stringify(screen, null, 2);
    });
  };
  const unsubscribe = agentUi.activity.subscribe(() => {
    const { busy, last } = agentUi.activity.get();
    if (!busy || !last || last.at === lastStarted) return;
    lastStarted = last.at;
    const via = last.origin.name
      ? `${last.origin.via} ${last.origin.name}`
      : last.origin.via;
    entries.unshift(`${new Date(last.at).toLocaleTimeString()} ${last.op} from ${via}`);
    entries.length = Math.min(entries.length, MAX_LOG);
    if (!panel.hidden) render();
  });
  let refresh: ReturnType<typeof setInterval> | undefined;
  const onKey = (event: KeyboardEvent) => {
    if (!(event.altKey && event.shiftKey && event.code === "KeyA")) return;
    panel.hidden = !panel.hidden;
    clearInterval(refresh);
    if (panel.hidden) return;
    render();
    refresh = setInterval(render, 1000);
  };
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("keydown", onKey);
    clearInterval(refresh);
    unsubscribe();
    panel.remove();
  };
}

export function installAgentUiDevtools(
  agentUi: AgentUiClient,
  clientId: string,
): () => void {
  window.__parlor = { clientId, screen: () => agentUi.screen() };
  const removeOverlay = overlay(agentUi, clientId);
  return () => {
    removeOverlay();
    delete window.__parlor;
  };
}
