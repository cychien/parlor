import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { FrameworkProvider } from "../provider.js";
import * as Chat from "./chat.js";
import { fakeClient } from "./fake-client.testing.js";

const prompt = (id: string, taskId: string) => ({
  id,
  action: "deleteTask",
  description: "Delete a task.",
  input: { id: taskId },
  origin: { via: "mcp", name: "Claude Code" },
  expiresInMs: 59_000,
});

const frame = (...items: ReturnType<typeof prompt>[]) =>
  JSON.stringify({ type: "confirmations", items });

function renderCards(
  items: ReturnType<typeof prompt>[],
  options: { delayRequest?: boolean; before?: ReactNode; wrap?: boolean } = {},
) {
  const { client, posts } = fakeClient({
    request: frame(...items),
    delayRequest: options.delayRequest ?? false,
  });
  const view = render(
    <FrameworkProvider
      client={client}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {options.before}
      <Chat.Confirmations data-testid="cards" empty={<p>No requests from agents</p>}>
        {(confirmation) => (
          <Chat.Confirm confirmation={confirmation} data-testid="card">
            <Chat.ConfirmLabel>
              {confirmation.origin.name} wants to delete{" "}
              {(confirmation.input as { id: string }).id}
            </Chat.ConfirmLabel>
            <Chat.Approve>Approve</Chat.Approve>
            <Chat.Decline>Decline</Chat.Decline>
          </Chat.Confirm>
        )}
      </Chat.Confirmations>
    </FrameworkProvider>,
  );
  return { ...view, posts };
}

describe("Chat.Confirmations", () => {
  it("shows the empty state and no pending count when nothing waits", () => {
    renderCards([], { delayRequest: true });
    const cards = screen.getByTestId("cards");
    expect(cards.getAttribute("aria-live")).toBe("polite");
    expect(cards.hasAttribute("data-pending")).toBe(false);
    expect(cards.textContent).toBe("No requests from agents");
  });

  it("renders one labelled card per pending confirmation and counts them", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const found = await screen.findAllByRole("group");
    expect(found.map((card) => card.getAttribute("data-action"))).toEqual([
      "deleteTask",
      "deleteTask",
    ]);
    expect(screen.getByRole("group", { name: "Claude Code wants to delete t1" })).toBe(
      found[0],
    );
    expect(screen.getByRole("group", { name: "Claude Code wants to delete t2" })).toBe(
      found[1],
    );
    expect(screen.getByTestId("cards").getAttribute("data-pending")).toBe("2");
    expect(screen.queryByText("No requests from agents")).toBeNull();
  });

  it("tells the server this client can confirm once it is mounted", async () => {
    const { posts } = renderCards([], { delayRequest: true });
    await waitFor(() =>
      expect(posts).toContainEqual(
        expect.objectContaining({ type: "presence", canConfirm: true }),
      ),
    );
  });

  it("answers the agent on Approve and drops the card", async () => {
    const { posts } = renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const first = (await screen.findAllByRole("group"))[0]!;
    fireEvent.click(within(first).getByRole("button", { name: "Approve" }));
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getByTestId("cards").getAttribute("data-pending")).toBe("1");
    await waitFor(() =>
      expect(posts).toContainEqual({ type: "answer", id: "c1", approve: true }),
    );
    expect(
      posts.filter((post) => (post as { type: string }).type === "answer"),
    ).toHaveLength(1);
  });

  it("answers the agent on Decline and shows the empty state when the last card goes", async () => {
    const { posts } = renderCards([prompt("c1", "t1")]);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByTestId("cards").hasAttribute("data-pending")).toBe(false);
    expect(screen.getByTestId("cards").textContent).toBe("No requests from agents");
    await waitFor(() =>
      expect(posts).toContainEqual({ type: "answer", id: "c1", approve: false }),
    );
  });

  it("composes a caller's onClick with the answer", async () => {
    const onClick = vi.fn();
    const { client, posts } = fakeClient({ request: frame(prompt("c1", "t1")) });
    render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Chat.Confirmations>
          {(confirmation) => (
            <Chat.Confirm confirmation={confirmation}>
              <Chat.Approve onClick={onClick}>Approve</Chat.Approve>
            </Chat.Confirm>
          )}
        </Chat.Confirmations>
      </FrameworkProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(posts).toContainEqual({ type: "answer", id: "c1", approve: true }),
    );
  });

  it("declines on Escape inside a card without letting an enclosing handler see it", async () => {
    const outer = vi.fn();
    const { posts } = renderCards([prompt("c1", "t1")]);
    document.addEventListener("keydown", outer);
    try {
      const approve = await screen.findByRole("button", { name: "Approve" });
      const notPrevented = fireEvent.keyDown(approve, { key: "Escape" });
      expect(notPrevented).toBe(false);
      expect(outer).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(posts).toContainEqual({ type: "answer", id: "c1", approve: false }),
      );
      expect(screen.queryByRole("group")).toBeNull();
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("ignores other keys", async () => {
    const outer = vi.fn();
    const { posts } = renderCards([prompt("c1", "t1")]);
    document.addEventListener("keydown", outer);
    try {
      const approve = await screen.findByRole("button", { name: "Approve" });
      expect(fireEvent.keyDown(approve, { key: "a" })).toBe(true);
      expect(outer).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole("group")).toHaveLength(1);
      expect(posts.some((post) => (post as { type: string }).type === "answer")).toBe(
        false,
      );
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("leaves focus where it was when a card appears", async () => {
    renderCards([prompt("c1", "t1")], {
      delayRequest: true,
      before: <input aria-label="Title" />,
    });
    const input = screen.getByLabelText("Title");
    input.focus();
    await screen.findByRole("group");
    expect(document.activeElement).toBe(input);
  });

  it("keeps the group labelled when a caller passes an id to the label", async () => {
    const { client } = fakeClient({ request: frame(prompt("c1", "t1")) });
    const labelProps = { id: "mine" };
    render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Chat.Confirmations>
          {(confirmation) => (
            <Chat.Confirm confirmation={confirmation}>
              <Chat.ConfirmLabel {...labelProps}>Who</Chat.ConfirmLabel>
            </Chat.Confirm>
          )}
        </Chat.Confirmations>
      </FrameworkProvider>,
    );
    const group = await screen.findByRole("group", { name: "Who" });
    const label = screen.getByText("Who");
    expect(label.id).toBe(group.getAttribute("aria-labelledby"));
    expect(label.id).not.toBe("mine");
  });

  it("makes each card and the list focusable without adding tab stops", async () => {
    renderCards([prompt("c1", "t1")]);
    const group = await screen.findByRole("group");
    expect(group.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByTestId("cards").getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus to the next card when the card holding focus is answered", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2"), prompt("c3", "t3")]);
    const [, second] = await screen.findAllByRole("group");
    const approve = within(second!).getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    const remaining = screen.getAllByRole("group");
    expect(remaining).toHaveLength(2);
    expect(document.activeElement).toBe(remaining[1]);
    expect(document.activeElement?.tagName).toBe("DIV");
  });

  it("moves focus to the previous card when the last card holding focus is answered", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const [first, second] = await screen.findAllByRole("group");
    const decline = within(second!).getByRole("button", { name: "Decline" });
    decline.focus();
    fireEvent.click(decline);
    expect(document.activeElement).toBe(first);
  });

  it("moves focus to the list when the only card holding focus is answered", async () => {
    renderCards([prompt("c1", "t1")]);
    const approve = await screen.findByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    expect(document.activeElement).toBe(screen.getByTestId("cards"));
  });

  it("keeps focus in the list when Escape declines the focused card", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const [first] = await screen.findAllByRole("group");
    const approve = within(first!).getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.keyDown(approve, { key: "Escape" });
    const remaining = screen.getAllByRole("group");
    expect(remaining).toHaveLength(1);
    expect(document.activeElement).toBe(remaining[0]);
  });

  it("moves focus to the card when the card itself holds focus", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const [first] = await screen.findAllByRole("group");
    first!.focus();
    fireEvent.keyDown(first!, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("group"));
  });

  it("never moves focus onto an answer button", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const [first] = await screen.findAllByRole("group");
    const approve = within(first!).getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("leaves focus alone when a card the user was not in is answered", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")], {
      before: <input aria-label="Title" />,
    });
    const [first, second] = await screen.findAllByRole("group");
    const input = screen.getByLabelText("Title");
    input.focus();
    fireEvent.click(within(first!).getByRole("button", { name: "Approve" }));
    expect(document.activeElement).toBe(input);
    const decline = within(second!).getByRole("button", { name: "Decline" });
    decline.focus();
    fireEvent.click(decline);
    expect(document.activeElement).toBe(screen.getByTestId("cards"));
  });

  it("leaves focus on another card when a different card is answered", async () => {
    renderCards([prompt("c1", "t1"), prompt("c2", "t2")]);
    const [first, second] = await screen.findAllByRole("group");
    const keep = within(second!).getByRole("button", { name: "Approve" });
    keep.focus();
    fireEvent.click(within(first!).getByRole("button", { name: "Decline" }));
    expect(document.activeElement).toBe(keep);
  });

  it("passes native props and refs through and ships no inline style", async () => {
    const group = createRef<HTMLDivElement>();
    const label = createRef<HTMLParagraphElement>();
    const approve = createRef<HTMLButtonElement>();
    const { client } = fakeClient({ request: frame(prompt("c1", "t1")) });
    const { container } = render(
      <FrameworkProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Chat.Confirmations className="list">
          {(confirmation) => (
            <Chat.Confirm confirmation={confirmation} ref={group} className="card">
              <Chat.ConfirmLabel ref={label} className="who">
                Who
              </Chat.ConfirmLabel>
              <Chat.Approve ref={approve} className="primary" disabled>
                Approve
              </Chat.Approve>
            </Chat.Confirm>
          )}
        </Chat.Confirmations>
      </FrameworkProvider>,
    );
    const card = await screen.findByRole("group");
    expect(group.current).toBe(card);
    expect(card.className).toBe("card");
    expect(label.current?.className).toBe("who");
    expect(approve.current?.className).toBe("primary");
    expect(approve.current?.disabled).toBe(true);
    expect(approve.current?.type).toBe("button");
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("explains itself when a part is used outside Chat.Confirm", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Chat.Approve>Approve</Chat.Approve>)).toThrow(
        "Chat.Approve must be rendered inside Chat.Confirm",
      );
      expect(() => render(<Chat.ConfirmLabel>Who</Chat.ConfirmLabel>)).toThrow(
        "Chat.ConfirmLabel must be rendered inside Chat.Confirm",
      );
    } finally {
      error.mockRestore();
    }
  });
});
