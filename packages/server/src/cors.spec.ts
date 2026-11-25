import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isAllowedOrigin } from "./cors.js";
import { createServer } from "./create-server.js";

const actions = createRegistry({
  hello: defineAction({
    description: "hi",
    input: z.object({}),
    run: () => ({ ok: true }),
  }),
});

function post(origin: string, body = "{}") {
  return new Request("http://app.test/_parlor/actions/hello", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body,
  });
}

describe("isAllowedOrigin", () => {
  it("allows local dev origins and configured extras, and no native shell's", () => {
    expect(isAllowedOrigin("tauri://localhost")).toBe(false);
    expect(isAllowedOrigin("capacitor://localhost")).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("https://evil.test")).toBe(false);
    expect(isAllowedOrigin("https://app.example.com", ["https://app.example.com"])).toBe(
      true,
    );
    expect(
      isAllowedOrigin("https://x.example.com", [/^https:\/\/[a-z]+\.example\.com$/]),
    ).toBe(true);
  });
});

describe("cors", () => {
  const server = createServer({ actions });

  it("answers preflight for a local dev origin", async () => {
    const response = await server.fetch(
      new Request("http://app.test/_parlor/actions/hello", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-parlor-source",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    const allowed = response.headers.get("access-control-allow-headers")?.toLowerCase();
    expect(allowed).toContain("x-parlor-source");
    expect(allowed).toContain("x-parlor-client");
  });

  it("adds the allow-origin header to successful and error responses", async () => {
    const ok = await server.fetch(post("http://localhost:5173"));
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(ok.headers.get("access-control-expose-headers")).toContain("x-parlor-build");
    const bad = await server.fetch(post("http://localhost:5173", "{nope"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("does not allow unknown origins", async () => {
    const response = await server.fetch(post("https://evil.test"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("can be disabled", async () => {
    const plain = createServer({ actions, cors: false });
    const response = await plain.fetch(post("http://localhost:5173"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
