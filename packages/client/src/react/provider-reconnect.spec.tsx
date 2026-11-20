import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import type { FrameworkAuth, ScopeSource, SessionSnapshot } from "../session.js";
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

function scopeSource(initial: string | undefined) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    scope: {
      current: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies ScopeSource,
    set(next: string | undefined) {
      current = next;
      for (const listener of listeners) act(() => listener());
    },
  };
}

function tokenClient(answer: (scope: string | null) => Response) {
  const negotiations: (string | null)[] = [];
  let scope: string | null = null;
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/sync/token")) {
      negotiations.push(scope);
      return answer(scope);
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
    sendScope: (next: string | null) => void (scope = next),
  };
}

describe("the browser sync connection of a scope", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects again in the scope the app switched to, and not when it stays", async () => {
    const fake = tokenClient(() => new Response("down", { status: 503 }));
    const org = scopeSource("org-a");
    fake.sendScope("org-a");
    const view = render(
      <FrameworkProvider
        client={fake.client}
        auth={sessionSource({ status: "signed-in", user: ada }).auth}
        scope={org.scope}
      >
        <p>app</p>
      </FrameworkProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.negotiations).toEqual(["org-a"]);

    org.set("org-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.negotiations).toEqual(["org-a"]);

    fake.sendScope("org-b");
    org.set("org-b");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.negotiations).toEqual(["org-a", "org-b"]);
    view.unmount();
  });

  it("tries again once the app leaves a scope the server refused", async () => {
    const fake = tokenClient((scope) =>
      scope === "gone"
        ? Response.json(
            { error: { code: "forbidden", message: "Not a member." } },
            { status: 403 },
          )
        : new Response("down", { status: 503 }),
    );
    const org = scopeSource("gone");
    fake.sendScope("gone");
    const view = render(
      <FrameworkProvider
        client={fake.client}
        auth={sessionSource({ status: "signed-in", user: ada }).auth}
        scope={org.scope}
      >
        <p>app</p>
      </FrameworkProvider>,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.negotiations).toEqual(["gone"]);

    fake.sendScope("org-a");
    org.set("org-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.negotiations).toEqual(["gone", "org-a"]);
    view.unmount();
  });
});
