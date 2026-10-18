import { ActionError } from "@parlor/core";
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

  describe("when a query fails", () => {
    function Probe({ name }: { name: "probe" | "other" }) {
      const query = useActionQuery(name, {}, { retryDelay: 0 });
      return (
        <output data-testid={name}>
          {query.isError ? `error:${query.error.message}` : "waiting"}
        </output>
      );
    }
    const answers = (probe: () => Promise<unknown>, other = probe) => {
      const client = createFakeClient();
      client.invoke.mockImplementation(((name: string) =>
        name === "other" ? other() : probe()) as never);
      return client;
    };
    const renderProbes = (
      client: ReturnType<typeof createFakeClient>,
      queryClient?: QueryClient,
    ) =>
      render(
        <FrameworkProvider client={client} queryClient={queryClient} sync={false}>
          <Probe name="probe" />
          <Probe name="other" />
        </FrameworkProvider>,
      );
    const calls = (client: ReturnType<typeof createFakeClient>, name: string) =>
      client.invoke.mock.calls.filter(([called]) => called === name).length;
    const shown = (name: string) => screen.getByTestId(name).textContent;

    it.each(["not_found", "invalid_input", "declined"] as const)(
      "asks once for an action that answers %s",
      async (code) => {
        const client = answers(async () => {
          throw new ActionError(code, `says ${code}`);
        });
        renderProbes(client);
        await waitFor(() => expect(shown("probe")).toBe(`error:says ${code}`));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(calls(client, "probe")).toBe(1);
      },
    );

    it("asks again after a network failure and after an internal error, but not after not_found", async () => {
      const outcomes = [
        new TypeError("Failed to fetch"),
        new ActionError("internal", "boom"),
        new ActionError("not_found", "gone"),
      ];
      let asked = 0;
      const client = answers(
        async () => {
          throw outcomes[Math.min(asked++, outcomes.length - 1)];
        },
        async () => ({ data: {}, tags: [] }),
      );
      renderProbes(client);
      await waitFor(() => expect(shown("probe")).toBe("error:gone"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls(client, "probe")).toBe(3);
    });

    it("leaves a retry setting on the query client in charge of the errors a retry can change", async () => {
      const client = answers(
        async () => {
          throw new ActionError("internal", "boom");
        },
        async () => {
          throw new ActionError("not_found", "gone");
        },
      );
      renderProbes(
        client,
        new QueryClient({ defaultOptions: { queries: { retry: 1 } } }),
      );
      await waitFor(() => expect(shown("probe")).toBe("error:boom"));
      await waitFor(() => expect(shown("other")).toBe("error:gone"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls(client, "probe")).toBe(2);
      expect(calls(client, "other")).toBe(1);
    });
  });

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Counter />)).toThrow(/inside <FrameworkProvider>/);
    spy.mockRestore();
  });
});
