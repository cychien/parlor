import { ActionError } from "@fw/core";
import { describe, expect, it, vi } from "vitest";

import { createActionClient } from "./action-client.js";

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
    expect(url).toBe("https://api.test/_fw/actions/hello");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"Ada"}');
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-fw-source")).toBe("ui");
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
