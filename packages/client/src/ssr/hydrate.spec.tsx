import type { ActionMap } from "@parlor/core";
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { actionQueryKey } from "../query-keys.js";
import { readTagsOf } from "../react/sync.js";
import { mount } from "../router/mount.js";
import { appServer, createApp, page, render, TEMPLATE } from "./app.testing.js";

afterEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  vi.restoreAllMocks();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

function fakeClient() {
  const client = {
    clientId: "tab",
    basePath: "/_parlor",
    invoke: vi.fn(async (_name: string, input: { id: string }) => ({
      data: { id: input.id, title: `Task ${input.id}` },
      tags: [],
    })),
    call: vi.fn(),
    request: vi.fn(),
  };
  return client as unknown as ActionClient<ActionMap> & typeof client;
}

/** The server renderer ran in this realm too, which React warns about outside any real page. */
function hydrationErrors(errors: ReturnType<typeof vi.spyOn>): unknown[][] {
  return errors.mock.calls.filter(
    ([message]) => !String(message).startsWith("Detected multiple renderers"),
  );
}

function loadDocument(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const link of parsed.querySelectorAll('link[rel="stylesheet"]')) link.remove();
  document.head.replaceChildren(...parsed.head.childNodes);
  document.body.replaceChildren(...parsed.body.childNodes);
  for (const script of document.querySelectorAll("script:not([src])")) {
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      value: script,
    });
    new Function(script.textContent ?? "").call(window);
  }
  Reflect.deleteProperty(document, "currentScript");
}

describe("mount", () => {
  it("hydrates a server-rendered page with its query cache and read tags, without mismatches", async () => {
    const server = appServer();
    const response = await render(page("/tasks/7"), {
      template: TEMPLATE,
      fetch: server.fetch,
      nonce: "n",
    });
    window.history.replaceState(null, "", "/tasks/7");
    loadDocument(await response!.text());
    const serverHeading = document.querySelector("h1");
    const errors = vi.spyOn(console, "error");
    const client = fakeClient();
    const app = createApp(client, false);

    mount(document.getElementById("root")!, app);

    await vi.waitFor(() => expect(app.router.state.status).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector("h1")).toBe(serverHeading);
    expect(serverHeading?.textContent).toBe("Task 7");
    expect(hydrationErrors(errors)).toEqual([]);
    expect(client.invoke).not.toHaveBeenCalled();
    const queryClient = app.router.options.context.queryClient;
    const key = actionQueryKey("getTask", { id: "7" });
    expect(queryClient.getQueryData(key)).toEqual({ id: "7", title: "Task 7" });
    const hash = queryClient.getQueryCache().find({ queryKey: key })!.queryHash;
    expect(readTagsOf(queryClient).tagsFor(hash)).toEqual([["tasks", "7"]]);
  });

  it("keeps the server's data however long the page took to arrive, without asking again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = appServer();
    const response = await render(page("/tasks/7"), {
      template: TEMPLATE,
      fetch: server.fetch,
      nonce: "n",
    });
    window.history.replaceState(null, "", "/tasks/7");
    loadDocument(await response!.text());
    vi.setSystemTime(Date.now() + 5000);
    const client = fakeClient();
    const app = createApp(client, false);

    mount(document.getElementById("root")!, app);

    await vi.waitFor(() => expect(app.router.state.status).toBe("idle"));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector("h1")?.textContent).toBe("Task 7");
    expect(client.invoke).not.toHaveBeenCalled();
  });

  it("renders from scratch when the server did not render the page", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "/settings");
    const client = fakeClient();

    mount(document.getElementById("root")!, createApp(client, false));

    await vi.waitFor(() => expect(document.body.textContent).toContain("settings"));
    expect(client.invoke).toHaveBeenCalledOnce();
  });
});
