import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { type ComponentProps, createRef } from "react";
import { describe, expect, it } from "vitest";

import { FrameworkProvider } from "../provider.js";
import * as Chat from "./chat.js";
import { agentRequest, fakeClient } from "./fake-client.testing.js";

function renderActivity(
  request: string,
  props: Partial<ComponentProps<typeof Chat.Activity>> = {},
) {
  const { client } = fakeClient({ request });
  const seen: string[] = [];
  const view = render(
    <FrameworkProvider
      client={client}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Chat.Activity {...props}>
        {(state) => {
          seen.push(state.status);
          return state.status === "idle"
            ? "No agent activity"
            : state.status === "refused"
              ? `${state.op} refused: ${state.code}`
              : `${state.op} ${state.status}`;
        }}
      </Chat.Activity>
    </FrameworkProvider>,
  );
  const transitions = () => seen.filter((status, i) => status !== seen[i - 1]);
  return { ...view, transitions };
}

describe("Chat.Activity", () => {
  it("is a polite status region that starts idle", () => {
    renderActivity(agentRequest("r1"), { linger: 60_000 });
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("data-state")).toBe("idle");
    expect(status.hasAttribute("data-op")).toBe(false);
    expect(status.textContent).toBe("No agent activity");
  });

  it("shows the op as done after the agent read the screen, then fades to idle after the linger", async () => {
    const { transitions } = renderActivity(agentRequest("r1", "screen"), {
      linger: 150,
    });
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.getAttribute("data-state")).toBe("done"));
    expect(status.getAttribute("data-op")).toBe("screen");
    expect(status.textContent).toBe("screen done");
    await waitFor(() => expect(status.getAttribute("data-state")).toBe("idle"));
    expect(status.hasAttribute("data-op")).toBe(false);
    expect(status.textContent).toBe("No agent activity");
    expect(transitions()).toEqual(["idle", "busy", "done", "idle"]);
  });

  it("reports a refused request with its error code", async () => {
    renderActivity(agentRequest("r1", "navigate", { to: "/nowhere" }), {
      linger: 60_000,
    });
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.getAttribute("data-state")).toBe("refused"));
    expect(status.getAttribute("data-op")).toBe("navigate");
    expect(status.textContent).toBe("navigate refused: unknown_route");
  });

  it("keeps a finished event on screen until the linger has passed", async () => {
    const { transitions } = renderActivity(agentRequest("r1", "screen"), {
      linger: 60_000,
    });
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.getAttribute("data-state")).toBe("done"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(status.getAttribute("data-state")).toBe("done");
    expect(transitions()).toEqual(["idle", "busy", "done"]);
  });

  it("passes native props and the ref through and sets no style", () => {
    const ref = createRef<HTMLSpanElement>();
    renderActivity(agentRequest("r1"), {
      ref,
      className: "agent-status",
      id: "activity",
      linger: 60_000,
    });
    const status = screen.getByRole("status");
    expect(ref.current).toBe(status);
    expect(status.className).toBe("agent-status");
    expect(status.id).toBe("activity");
    expect(status.hasAttribute("style")).toBe(false);
  });
});
