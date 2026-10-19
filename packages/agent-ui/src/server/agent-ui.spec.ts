import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

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

describe("contextFor with a chat turn", () => {
  function twoFocusedTabs() {
    const agentUi = createAgentUi({ audience: () => "default" });
    const requests: Record<string, string[]> = { "tab-1": [], "tab-2": [] };
    for (const clientId of ["tab-1", "tab-2"]) {
      agentUi.channel.connect({
        clientId,
        scope: "default",
        send: (data) => requests[clientId]!.push(data),
      });
      agentUi.receive(clientId, "default", {
        type: "presence",
        focused: true,
        visible: true,
        platform: "web",
      });
    }
    agentUi.install(() => manifest);
    const navigate = agentUi.tools("mcp").find((tool) => tool.name === "ui_navigate")!;
    const mcp = new Request("http://localhost:3300/_parlor/mcp");
    return { agentUi, requests, navigate, mcp };
  }

  it("binds ui tools to the tab that sent the prompt although both tabs are focused", async () => {
    const { agentUi, requests, navigate, mcp } = twoFocusedTabs();
    const ctx = await agentUi.contextFor(mcp, { via: "agent" }, undefined, {
      clientId: "tab-1",
    });
    expect(ctx.clientId).toBe("tab-1");

    const running = navigate.run({ to: "/settings" }, ctx);
    await vi.waitFor(() => expect(requests["tab-1"]).toHaveLength(1));
    expect(requests["tab-2"]).toEqual([]);
    const { id } = JSON.parse(requests["tab-1"]![0]!) as { id: string };
    agentUi.receive("tab-1", "default", {
      type: "reply",
      id,
      ok: true,
      result: { screen: { route: null } },
    });
    await expect(running).resolves.toMatchObject({
      client: { id: "tab-1" },
      screen: { route: null },
    });
  });

  it("reports unknown_client when the prompt's tab has left", async () => {
    const { agentUi, navigate, mcp } = twoFocusedTabs();
    const ctx = await agentUi.contextFor(mcp, { via: "agent" }, undefined, {
      clientId: "tab-closed",
    });
    await expect(navigate.run({ to: "/settings" }, ctx)).rejects.toMatchObject({
      error: { code: "unknown_client" },
    });
  });
});
