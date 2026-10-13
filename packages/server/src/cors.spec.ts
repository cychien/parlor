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
  it("allows shell origins, local dev origins, and configured extras", () => {
    expect(isAllowedOrigin("tauri://localhost")).toBe(true);
    expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
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

  it("answers preflight for a shell origin", async () => {
    const response = await server.fetch(
      new Request("http://app.test/_parlor/actions/hello", {
        method: "OPTIONS",
        headers: {
          origin: "tauri://localhost",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-parlor-source",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-parlor-source",
    );
  });

  it("adds the allow-origin header to successful and error responses", async () => {
    const ok = await server.fetch(post("capacitor://localhost"));
    expect(ok.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    const bad = await server.fetch(post("capacitor://localhost", "{nope"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
  });

  it("does not allow unknown origins", async () => {
    const response = await server.fetch(post("https://evil.test"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("can be disabled", async () => {
    const plain = createServer({ actions, cors: false });
    const response = await plain.fetch(post("tauri://localhost"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
