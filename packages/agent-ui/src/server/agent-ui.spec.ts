import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { UiManifest } from "../manifest.js";
import { createAgentUi, webOriginFromEnv } from "./agent-ui.js";

const manifest: UiManifest = {
  protocol: 1,
  app: { id: "dev.parlor.test", name: "Test" },
  routes: [{ path: "/settings", description: "Settings.", params: [], views: [] }],
  views: [],
};

async function hrefWhenClosed(webOrigin: string | undefined) {
  const agentUi = createAgentUi({ scope: () => "default", webOrigin });
  agentUi.install(() => manifest);
  const navigate = agentUi.tools("agent").find((tool) => tool.name === "ui_navigate")!;
  const ctx = await agentUi.contextFor(new Request("http://localhost:3300/_parlor/mcp"), {
    via: "mcp",
  });
  return navigate.run({ to: "/settings" }, ctx);
}

describe("unreachable links", () => {
  it("point at the web origin the dev server serves the app on", async () => {
    await expect(hrefWhenClosed("http://localhost:5173")).resolves.toEqual({
      reachable: false,
      reason: "no_client",
      href: "http://localhost:5173/settings",
    });
  });

  it("fall back to the origin the agent's request came in on", async () => {
    await expect(hrefWhenClosed(undefined)).resolves.toEqual({
      reachable: false,
      reason: "no_client",
      href: "http://localhost:3300/settings",
    });
  });
});

describe("webOriginFromEnv", () => {
  it("accepts only an http origin", () => {
    expect(webOriginFromEnv("http://localhost:5173")).toBe("http://localhost:5173");
    expect(webOriginFromEnv("")).toBeUndefined();
    expect(webOriginFromEnv(undefined)).toBeUndefined();
  });

  it("reads the literal process.env.PARLOR_WEB_ORIGIN", async () => {
    const source = await readFile(new URL("./agent-ui.ts", import.meta.url), "utf8");
    expect(source).toContain("= process.env.PARLOR_WEB_ORIGIN");
  });
});
