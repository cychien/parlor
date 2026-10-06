import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { useActionMutation, useActionQuery } from "./hooks.js";
import { FrameworkProvider } from "./provider.js";

function createFakeClient() {
  let count = 0;
  const call = vi.fn(async (name: string, input: unknown) => {
    if (name === "count") return { count };
    if (name === "increment") {
      count += 1;
      return { count };
    }
    throw new Error(`unexpected ${name} ${JSON.stringify(input)}`);
  });
  return { call } as unknown as ActionClient<Record<string, never>> & {
    call: typeof call;
  };
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
    <FrameworkProvider client={client} queryClient={queryClient}>
      <Counter />
    </FrameworkProvider>,
  );
}

describe("useActionQuery / useActionMutation", () => {
  it("loads data through the client and refetches after a mutation", async () => {
    const client = createFakeClient();
    renderCounter(client);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("count:0"));
    expect(client.call).toHaveBeenCalledWith("count", {}, expect.anything());

    await act(async () => {
      screen.getByRole("button").click();
    });

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("count:1"));
    expect(client.call).toHaveBeenCalledWith("increment", {});
  });

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Counter />)).toThrow(/inside <FrameworkProvider>/);
    spy.mockRestore();
  });
});
