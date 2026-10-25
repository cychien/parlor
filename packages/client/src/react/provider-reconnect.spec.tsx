import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import type { FrameworkAuth, SessionSnapshot } from "../session.js";
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

function sessionSource(initial: SessionSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    auth: {
      current: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as FrameworkAuth,
    set(next: SessionSnapshot) {
      current = next;
      for (const listener of listeners) act(() => listener());
    },
  };
}

function refusingClient() {
  const negotiations: number[] = [];
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/sync/token")) {
      negotiations.push(Date.now());
      return new Response(null, { status: 401 });
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

const ada = { id: "ada", name: "Ada", email: "ada@example.com" };

describe("the browser sync connection of a session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never asks the server while signed out, and connects once the session signs in", async () => {
    const { client, negotiations } = refusingClient();
    const session = sessionSource({ status: "loading" });
    const view = render(
      <FrameworkProvider client={client} auth={session.auth}>
        <p>app</p>
      </FrameworkProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
    session.set({ status: "signed-out" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(negotiations).toHaveLength(0);

    session.set({ status: "signed-in", user: ada });
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(1);
    view.unmount();
  });

  it("stops after the server refuses it, until the session changes", async () => {
    const { client, negotiations } = refusingClient();
    const session = sessionSource({ status: "signed-in", user: ada });
    const view = render(
      <FrameworkProvider client={client} auth={session.auth}>
        <p>app</p>
      </FrameworkProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(1);

    session.set({ status: "signed-in", user: ada });
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toHaveLength(2);
    view.unmount();
  });

  it("keeps retrying with backoff when the provider cannot see the session", async () => {
    const { client, negotiations } = refusingClient();
    const view = render(
      <FrameworkProvider client={client}>
        <p>app</p>
      </FrameworkProvider>,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(negotiations.length).toBeGreaterThan(2);
    view.unmount();
  });
});
