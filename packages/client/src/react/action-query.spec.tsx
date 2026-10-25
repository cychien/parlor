import { ActionError } from "@parlor/core";
import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { ACTION_QUERY_PREFIX, actionQueryKey } from "../query-keys.js";
import { actionQueryOptions, ensureActionQueryData } from "./action-query.js";
import { useActionQuery, useActionSuspenseQuery } from "./hooks.js";
import { FrameworkProvider } from "./provider.js";
import { readTagsOf } from "./sync.js";

function fakeClient() {
  let version = 0;
  const invoke = vi.fn(async (name: string, input: { id?: string }) => {
    if (name === "getTask") {
      version += 1;
      return { data: { id: input.id, version }, tags: [["tasks", input.id ?? ""]] };
    }
    if (name === "missing") throw new ActionError("not_found", "No such task");
    throw new Error(`unexpected ${name}`);
  });
  const client = {
    clientId: "tab",
    basePath: "/_parlor",
    invoke,
    call: vi.fn(),
    request: vi.fn(),
  };
  return client as unknown as ActionClient<Record<string, never>> & typeof client;
}

function setup() {
  const client = fakeClient();
  const queryClient = new QueryClient();
  return { client, queryClient, context: { client, queryClient } };
}

const hashOf = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryCache().find({ queryKey: key, exact: true })!.queryHash;

describe("ensureActionQueryData", () => {
  it("fetches once into the entry useActionQuery reads, and records its read tags", async () => {
    const { client, queryClient, context } = setup();

    const [first, second] = await Promise.all([
      ensureActionQueryData(context, "getTask", { id: "42" }),
      ensureActionQueryData(context, "getTask", { id: "42" }),
    ]);
    const third = await ensureActionQueryData(context, "getTask", { id: "42" });

    expect(client.invoke).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ id: "42", version: 1 });
    expect(second).toBe(first);
    expect(third).toBe(first);
    const key = actionQueryKey("getTask", { id: "42" });
    expect(queryClient.getQueryData(key)).toBe(first);
    expect(readTagsOf(queryClient).tagsFor(hashOf(queryClient, key))).toEqual([
      ["tasks", "42"],
    ]);
  });

  it("fetches again once a write invalidated the cached data", async () => {
    const { client, queryClient, context } = setup();
    await ensureActionQueryData(context, "getTask", { id: "42" });

    await queryClient.invalidateQueries({ queryKey: ACTION_QUERY_PREFIX });

    await expect(
      ensureActionQueryData(context, "getTask", { id: "42" }),
    ).resolves.toEqual({
      id: "42",
      version: 2,
    });
    expect(client.invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects with the action's ActionError, asking once", async () => {
    const { client, context } = setup();
    const failure = await ensureActionQueryData(context, "missing", {}).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ActionError);
    expect((failure as ActionError).code).toBe("not_found");
    expect(client.invoke).toHaveBeenCalledTimes(1);
  });

  it("is what actionQueryOptions prefetches", async () => {
    const { client, queryClient, context } = setup();
    await queryClient.prefetchQuery(actionQueryOptions(context, "getTask", { id: "7" }));
    await ensureActionQueryData(context, "getTask", { id: "7" });
    expect(client.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("reading ensured data in a component", () => {
  const shown = (task: { readonly version: number } | undefined) => (
    <output>{task ? `version:${task.version}` : "empty"}</output>
  );
  function SuspenseTask() {
    return shown(
      useActionSuspenseQuery("getTask", { id: "42" }).data as { version: number },
    );
  }
  function PlainTask() {
    return shown(
      useActionQuery("getTask", { id: "42" }).data as { version: number } | undefined,
    );
  }
  const Task = ({ suspense }: { readonly suspense: boolean }) =>
    suspense ? <SuspenseTask /> : <PlainTask />;

  async function renderEnsured(suspense: boolean) {
    const { client, queryClient, context } = setup();
    await ensureActionQueryData(context, "getTask", { id: "42" });
    render(
      <FrameworkProvider client={client} queryClient={queryClient} sync={false}>
        <Suspense fallback={<p>loading</p>}>
          <Task suspense={suspense} />
        </Suspense>
      </FrameworkProvider>,
    );
    return client;
  }

  it("useActionSuspenseQuery renders it at once, without asking again", async () => {
    const client = await renderEnsured(true);
    expect(screen.getByRole("status").textContent).toBe("version:1");
    expect(screen.queryByText("loading")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.invoke).toHaveBeenCalledTimes(1);
  });

  it("useActionQuery renders it on its first render", async () => {
    await renderEnsured(false);
    expect(screen.getByRole("status").textContent).toBe("version:1");
  });

  it("useActionSuspenseQuery suspends until the action answers when nothing ensured it", async () => {
    const { client, queryClient } = setup();
    render(
      <FrameworkProvider client={client} queryClient={queryClient} sync={false}>
        <Suspense fallback={<p>loading</p>}>
          <Task suspense />
        </Suspense>
      </FrameworkProvider>,
    );
    expect(screen.getByText("loading")).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toBe("version:1");
  });
});
