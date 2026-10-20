import { describe, expect, it } from "vitest";

import { createAgentUi } from "./agent-ui.js";

describe("regression-guard: an external agent facing two focused tabs", () => {
  it("answers ambiguous_client and sends neither tab a request", async () => {
    const agentUi = createAgentUi({ audience: () => "default" });
    const sent: Record<string, string[]> = { "tab-1": [], "tab-2": [] };
    for (const clientId of ["tab-1", "tab-2"]) {
      agentUi.channel.connect({
        clientId,
        scope: "default",
        send: (data) => sent[clientId]!.push(data),
      });
      agentUi.receive(clientId, "default", {
        type: "presence",
        focused: true,
        visible: true,
        platform: "web",
      });
    }
    const navigate = agentUi.tools("mcp").find((tool) => tool.name === "ui_navigate")!;
    const ctx = await agentUi.contextFor(
      new Request("http://localhost:3300/_parlor/mcp"),
      { via: "mcp" },
    );

    await expect(navigate.run({ to: "/settings" }, ctx)).rejects.toMatchObject({
      error: { code: "ambiguous_client" },
    });
    expect(sent).toEqual({ "tab-1": [], "tab-2": [] });
  });
});
