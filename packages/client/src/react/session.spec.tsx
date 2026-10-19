import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import type { SessionSnapshot, SessionSource } from "../session.js";
import { useActionQuery } from "./hooks.js";
import { FrameworkProvider, useSession } from "./provider.js";

function fakeSession(initial: SessionSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const source: SessionSource = {
    current: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    set(next: SessionSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

const signedIn = (id: string): SessionSnapshot => ({
  status: "signed-in",
  user: { id, name: id, email: `${id}@example.com` },
});

function fakeClient() {
  let who = "nobody";
  const invoke = vi.fn(async () => ({ data: { who }, tags: [] }));
  const negotiations: number[] = [];
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/sync/token")) negotiations.push(Date.now());
    return new Response(null, { status: 401 });
  });
  const client = {
    clientId: "tab",
    basePath: "/_parlor",
    invoke,
    call: async () => (await invoke()).data,
    request,
  };
  return {
    client: client as unknown as ActionClient<Record<string, never>>,
    invoke,
    negotiations,
    become(next: string) {
      who = next;
    },
  };
}

function Who() {
  const session = useSession();
  const query = useActionQuery("whoami", {});
  return (
    <>
      <output data-testid="session">
        {session.status === "signed-in" ? session.user.id : session.status}
      </output>
      <output data-testid="data">{query.data?.who ?? "none"}</output>
    </>
  );
}

describe("FrameworkProvider with auth", () => {
  it("resets queries and reconnects sync when the signed-in user changes", async () => {
    const session = fakeSession({ status: "loading" });
    const fake = fakeClient();
    fake.become("alice");
    render(
      <FrameworkProvider
        client={fake.client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        auth={session.source}
      >
        <Who />
      </FrameworkProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("alice"));
    act(() => session.set(signedIn("alice")));
    expect(screen.getByTestId("session").textContent).toBe("alice");
    await waitFor(() => expect(fake.negotiations.length).toBeGreaterThan(0));
    const calls = fake.invoke.mock.calls.length;
    const negotiations = fake.negotiations.length;

    fake.become("bob");
    act(() => session.set(signedIn("bob")));
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("bob"));
    expect(fake.invoke.mock.calls.length).toBe(calls + 1);
    await waitFor(() => expect(fake.negotiations.length).toBeGreaterThan(negotiations));
  });

  it("does not refetch when the first answer settles", async () => {
    const session = fakeSession({ status: "loading" });
    const fake = fakeClient();
    render(
      <FrameworkProvider client={fake.client} sync={false} auth={session.source}>
        <Who />
      </FrameworkProvider>,
    );
    await waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(1));
    act(() => session.set(signedIn("alice")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses useSession without auth", () => {
    const fake = fakeClient();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <FrameworkProvider client={fake.client} sync={false}>
          <Who />
        </FrameworkProvider>,
      ),
    ).toThrow(/useSession needs/);
    spy.mockRestore();
  });
});
