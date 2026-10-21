import { ActionError } from "@parlor/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appOrigin, createActionClient } from "./action-client.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => Response.json(body, { status }));
}

describe("createActionClient", () => {
  it("posts JSON to the action route with the ui source header", async () => {
    const fetch = fakeFetch(200, { data: { message: "hi" } });
    const client = createActionClient({ baseUrl: "https://api.test", fetch });

    await expect(client.call("hello", { name: "Ada" })).resolves.toEqual({
      message: "hi",
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/_parlor/actions/hello");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"Ada"}');
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-parlor-source")).toBe("ui");
  });

  it("merges static and async custom headers", async () => {
    const fetch = fakeFetch(200, { data: null });
    const client = createActionClient({
      fetch,
      headers: async () => ({ authorization: "Bearer t" }),
    });
    await client.call("hello", {});
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
  });

  it("sends an empty object when input is undefined", async () => {
    const fetch = fakeFetch(200, { data: null });
    await createActionClient({ fetch }).call("hello", undefined);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe("{}");
  });

  it("rethrows framework error bodies as ActionError", async () => {
    const fetch = fakeFetch(400, {
      error: { code: "invalid_input", message: "bad", issues: [{ path: ["name"] }] },
    });
    const error = await createActionClient({ fetch })
      .call("hello", {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("invalid_input");
    expect((error as ActionError).issues?.[0]?.path).toEqual(["name"]);
  });

  it("wraps non-framework failures as internal errors", async () => {
    const fetch = vi.fn(async () => new Response("gateway down", { status: 502 }));
    const error = await createActionClient({ fetch })
      .call("hello", {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("internal");
    expect((error as ActionError).message).toContain("502");
  });

  it("forwards the abort signal", async () => {
    const fetch = fakeFetch(200, { data: null });
    const controller = new AbortController();
    await createActionClient({ fetch }).call("hello", {}, { signal: controller.signal });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("client identity and envelopes", () => {
  it("sends a stable client id header and exposes the envelope with tags", async () => {
    const fetch = fakeFetch(200, { data: { ok: true }, tags: [["tasks"]] });
    const client = createActionClient({ fetch, clientId: "tab-1" });
    const envelope = await client.invoke("listTasks", {});
    expect(envelope).toEqual({ data: { ok: true }, tags: [["tasks"]] });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-parlor-client")).toBe("tab-1");
    expect(client.clientId).toBe("tab-1");
  });

  it("generates a client id when none is given", () => {
    expect(createActionClient({ fetch: fakeFetch(200, {}) }).clientId).toMatch(/.+/);
  });

  it("request() prefixes the base url and keeps framework headers", async () => {
    const fetch = fakeFetch(200, {});
    const client = createActionClient({
      fetch,
      baseUrl: "https://api.test",
      clientId: "t",
    });
    await client.request("/_parlor/sync/token", { method: "POST" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/_parlor/sync/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-parlor-source")).toBe("ui");
  });
});

describe("appOrigin", () => {
  const SERVER = "https://hello.example.com/api";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pageAt(origin: string) {
    vi.stubGlobal("location", { origin });
  }

  it("is the page origin when the app is served over http(s)", () => {
    pageAt("https://hello.example.com");
    expect(appOrigin(SERVER)).toBe("https://hello.example.com");
  });

  it.each([
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
  ])("is the server origin in the %s webview", (origin) => {
    pageAt(origin);
    expect(appOrigin(SERVER)).toBe("https://hello.example.com");
  });

  it("keeps a dev server page origin that is not a shell origin", () => {
    pageAt("http://localhost:5173");
    expect(appOrigin(SERVER)).toBe("http://localhost:5173");
  });

  it("is the server URL itself when it is not a URL", () => {
    pageAt("tauri://localhost");
    expect(appOrigin("not a url")).toBe("not a url");
  });
});
