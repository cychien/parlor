import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { useActionMutation, useActionQuery } from "./hooks.js";
import { FrameworkProvider } from "./provider.js";

function createFakeClient() {
  let count = 0;
  const invoke = vi.fn(async (name: string, input: unknown) => {
    if (name === "count") return { data: { count }, tags: [["counter"]] };
    if (name === "increment") {
      count += 1;
      return { data: { count }, tags: [] };
    }
    throw new Error(`unexpected ${name} ${JSON.stringify(input)}`);
  });
  const client = {
    clientId: "test-tab",
    basePath: "/_parlor",
    invoke,
    call: async (name: string, input: unknown) => (await invoke(name, input)).data,
    request: vi.fn(),
  };
  return client as unknown as ActionClient<Record<string, never>> & typeof client;
}

function Counter() {
  const query = useActionQuery("count", {});
  const increment = useActionMutation("increment");
  return (
    <div>
      <output>{query.isPending ? "loading" : `count:${query.data?.count}`}</output>
      <button onClick={() => increment.mutate({})}>inc</button>
    </div>
  );
}

function renderCounter(client: ActionClient<Record<string, never>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FrameworkProvider client={client} queryClient={queryClient} sync={false}>
      <Counter />
    </FrameworkProvider>,
  );
}

describe("useActionQuery / useActionMutation", () => {
  it("loads data through the client and refetches after a mutation", async () => {
    const client = createFakeClient();
    renderCounter(client);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("count:0"));
    expect(client.invoke).toHaveBeenCalledWith("count", {}, expect.anything());

    await act(async () => {
      screen.getByRole("button").click();
    });

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("count:1"));
    expect(client.invoke).toHaveBeenCalledWith("increment", {});
  });

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Counter />)).toThrow(/inside <FrameworkProvider>/);
    spy.mockRestore();
  });
});
