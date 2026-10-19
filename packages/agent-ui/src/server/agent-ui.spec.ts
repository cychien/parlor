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
  const agentUi = createAgentUi({ audience: () => "default", webOrigin });
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

describe("an installed manifest that predates writable views", () => {
  const legacy = {
    protocol: 1 as const,
    app: { id: "dev.parlor.test", name: "Test" },
    routes: [{ path: "/", params: [], views: ["form"] }],
    views: [{ name: "form", description: "A form.", keyed: false }],
  };

  it("reads every view as read-only instead of failing the tools built from it", () => {
    const agentUi = createAgentUi({ audience: () => "default" });
    agentUi.install(() => legacy);
    expect(agentUi.manifest()?.views).toEqual([{ ...legacy.views[0], writable: [] }]);
    expect(agentUi.tools("mcp").map((tool) => tool.name)).toContain("ui_set");
  });

  it("hands out the same manifest object while the source keeps returning the same one", () => {
    const agentUi = createAgentUi({ audience: () => "default" });
    agentUi.install(() => legacy);
    expect(agentUi.manifest()).toBe(agentUi.manifest());
    expect(agentUi.manifest()?.views[0]?.writable).toEqual([]);
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
