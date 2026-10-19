import { ActionError, type ActionMap } from "@parlor/core";
import { describe, expect, it, vi } from "vitest";

import { createActionClient } from "./action-client.js";
import { createPluginClient } from "./plugin-client.js";

function clientWith(respond: (path: string, init: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string, init: RequestInit) =>
    respond(new URL(url).pathname, init),
  );
  const client = createActionClient({
    baseUrl: "https://api.test",
    fetch,
    clientId: "tab-1",
    headers: { authorization: "Bearer session" },
  });
  return { client, fetch };
}

describe("createPluginClient", () => {
  it("posts to the plugin's action route with the app client's headers and client id", async () => {
    const { client, fetch } = clientWith(() =>
      Response.json({ data: { id: "thr_1" }, tags: [["parlor_chat", "thr_1"]] }),
    );
    const chat = createPluginClient<ActionMap>(client, "chat");

    await expect(chat.call("send", { threadId: "thr_1" })).resolves.toEqual({
      id: "thr_1",
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.test/_parlor/chat/actions/send");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"threadId":"thr_1"}');
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer session");
    expect(headers.get("x-parlor-client")).toBe("tab-1");
    expect(headers.get("x-parlor-source")).toBe("ui");
  });

  it("returns the tags the write produced from invoke", async () => {
    const { client } = clientWith(() =>
      Response.json({ data: { id: "thr_1" }, tags: [["parlor_chat", "thr_1"]] }),
    );
    const envelope = await createPluginClient<ActionMap>(client, "chat").invoke(
      "send",
      {},
    );
    expect(envelope).toEqual({ data: { id: "thr_1" }, tags: [["parlor_chat", "thr_1"]] });
  });

  it("rethrows the framework's error body as an ActionError", async () => {
    const { client } = clientWith(() =>
      Response.json(
        { error: { code: "not_found", message: "No such thread." } },
        { status: 404 },
      ),
    );
    const error = await createPluginClient<ActionMap>(client, "chat")
      .call("items", {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({ code: "not_found", message: "No such thread." });
  });

  it("reports a server that has no such plugin as not_found, not internal", async () => {
    const { client } = clientWith(() => new Response("Not Found", { status: 404 }));
    const error = await createPluginClient<ActionMap>(client, "chat")
      .call("open", {})
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "not_found",
      message: "Action request failed with HTTP 404",
    });
  });

  it("keeps an app action's bodiless 404 an internal error", async () => {
    const { client } = clientWith(() => new Response("Not Found", { status: 404 }));
    const error = await client.call("hello", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "internal" });
  });
});
