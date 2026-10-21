import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { FrameworkProvider } from "./provider.js";

function offlineClient() {
  const negotiations: number[] = [];
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/sync/token")) {
      negotiations.push(Date.now());
      return new Response("down", { status: 503 });
    }
    return Response.json({ events: [], cursor: "" });
  });
  const client = {
    clientId: "tab",
    basePath: "/_parlor",
    invoke: vi.fn(),
    call: vi.fn(),
    request,
  };
  return {
    client: client as unknown as ActionClient<Record<string, never>>,
    negotiations,
  };
}

describe("the browser sync connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function mounted() {
    const fake = offlineClient();
    const view = render(
      <FrameworkProvider client={fake.client}>
        <p>app</p>
      </FrameworkProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3500);
    return { ...fake, view };
  }

  it("negotiates again at once when the browser comes back online, instead of waiting out the backoff", async () => {
    const { negotiations, view } = await mounted();
    const before = negotiations.length;
    expect(before).toBeGreaterThanOrEqual(2);

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(before + 1);
    view.unmount();
  });

  it("negotiates again at once when the tab becomes visible", async () => {
    const { negotiations, view } = await mounted();
    const before = negotiations.length;

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(before + 1);
    view.unmount();
  });

  it("stops listening once the provider unmounts", async () => {
    const { negotiations, view } = await mounted();
    view.unmount();
    const before = negotiations.length;

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(before);
  });
});
