import { describe, expect, it } from "vitest";

import type { AgentAsk } from "./acp.js";
import { approvalFor, DEFAULT_POLICY, DEV_POLICY, isAppTool } from "./policy.js";

const permission = (mcp?: { server: string; tool: string }): AgentAsk => ({
  kind: "permission",
  toolCallId: "t1",
  title: "Run",
  toolKind: "execute",
  mcp,
  options: [{ id: "allow", label: "Allow", effect: "allow_once" }],
});
const question: AgentAsk = { kind: "question", message: "Which?", schema: {} };

describe("RemotePolicy", () => {
  it("lets only this app's own MCP tools skip the user", () => {
    expect(isAppTool(permission({ server: "hello", tool: "createTask" }), "hello")).toBe(
      true,
    );
    expect(isAppTool(permission({ server: "other", tool: "createTask" }), "hello")).toBe(
      false,
    );
    expect(isAppTool(permission(), "hello")).toBe(false);
    expect(isAppTool(question, "hello")).toBe(false);
  });

  it("asks any device without presence under the dev policy every phase 4 grant runs", () => {
    expect(approvalFor(DEV_POLICY, permission())).toBeUndefined();
    expect(approvalFor(DEV_POLICY, question)).toBeUndefined();
  });

  it("asks for presence or the computer itself as the computer's policy says", () => {
    expect(approvalFor(DEFAULT_POLICY, permission())).toBe("presence");
    expect(
      approvalFor({ deviceApproval: "local", answers: "computer" }, permission()),
    ).toBe("computer");
    expect(approvalFor(DEFAULT_POLICY, question)).toBeUndefined();
  });
});
