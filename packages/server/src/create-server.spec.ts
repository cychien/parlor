import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createServer } from "./create-server.js";

const actions = createRegistry({
  hello: defineAction({
    description: "Say hello.",
    input: z.object({ name: z.string().default("world") }),
    run: ({ name }, ctx) => ({
      message: `Hello, ${name}!`,
      scope: ctx.scope,
      source: ctx.source,
    }),
  }),
  explode: defineAction({
    description: "Always fails.",
    input: z.object({}),
    run: () => {
      throw new Error("secret detail");
    },
  }),
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("createServer", () => {
  const server = createServer({ actions });

  it("serves the manifest", async () => {
    const response = await server.fetch(new Request("http://app.test/_parlor/manifest"));
    expect(response.status).toBe(200);
    const manifest = await response.json();
    expect(manifest.protocol).toBe(1);
    expect(manifest.actions.map((a: { name: string }) => a.name)).toEqual([
      "hello",
      "explode",
    ]);
  });

  it("runs an action and wraps the result in data", async () => {
    const response = await server.fetch(post("/_parlor/actions/hello", { name: "Ada" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { message: "Hello, Ada!", scope: "default", source: "http" },
    });
  });

  it("applies schema defaults to an empty body", async () => {
    const response = await server.fetch(post("/_parlor/actions/hello", {}));
    await expect(response.json()).resolves.toMatchObject({
      data: { message: "Hello, world!" },
    });
  });

  it("returns 400 with issues for invalid input", async () => {
    const response = await server.fetch(post("/_parlor/actions/hello", { name: 1 }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.issues[0].path).toEqual(["name"]);
  });

  it("returns 400 when the body is not JSON", async () => {
    const response = await server.fetch(post("/_parlor/actions/hello", "{not json"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_input", message: "Request body must be JSON" },
    });
  });

  it("returns 404 for unknown actions", async () => {
    const response = await server.fetch(post("/_parlor/actions/nope", {}));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("masks unexpected errors as 500 internal", async () => {
    const response = await server.fetch(post("/_parlor/actions/explode", {}));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toEqual({ code: "internal", message: "Internal error" });
  });

  it("resolves scope from the request and reads the source header", async () => {
    const scope = vi.fn(
      (request: Request) => request.headers.get("x-org") ?? "anonymous",
    );
    const scoped = createServer({ actions, scope });
    const response = await scoped.fetch(
      post("/_parlor/actions/hello", {}, { "x-org": "acme", "x-parlor-source": "ui" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { scope: "acme", source: "ui" },
    });
    expect(scope).toHaveBeenCalledOnce();
  });

  it("ignores unknown source headers", async () => {
    const response = await server.fetch(
      post("/_parlor/actions/hello", {}, { "x-parlor-source": "evil" }),
    );
    await expect(response.json()).resolves.toMatchObject({ data: { source: "http" } });
  });

  it("honours a custom base path", async () => {
    const custom = createServer({ actions, basePath: "/api/fw" });
    const response = await custom.fetch(new Request("http://app.test/api/fw/manifest"));
    expect(response.status).toBe(200);
  });
});
