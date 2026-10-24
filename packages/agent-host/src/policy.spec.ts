import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentAsk } from "./acp.js";
import {
  approvalFor,
  changePolicy,
  DEFAULT_POLICY,
  DEV_POLICY,
  isAppTool,
  loadPolicy,
} from "./policy.js";

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

describe("the policy file", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "parlor-policy-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is the default policy until `parlor-host config` writes something", async () => {
    expect(await loadPolicy(join(dir, "absent.json"), DEFAULT_POLICY)).toEqual(
      DEFAULT_POLICY,
    );
  });

  it("overlays only the settings it holds, read afresh every time, in a 0600 file", async () => {
    const file = join(dir, "overlay", "policy.json");
    expect(await changePolicy(file, DEFAULT_POLICY, { answers: "computer" })).toEqual({
      deviceApproval: "local",
      answers: "computer",
      promptPresence: { maxAgeHours: 18 },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ answers: "computer" });
    expect(await changePolicy(file, DEFAULT_POLICY, { answers: "presence" })).toEqual(
      DEFAULT_POLICY,
    );
    await writeFile(
      file,
      JSON.stringify({ deviceApproval: "off", answers: "off", promptPresence: "off" }),
    );
    expect(await loadPolicy(file, DEFAULT_POLICY)).toEqual(DEV_POLICY);
    expect(
      await changePolicy(file, DEFAULT_POLICY, { promptPresence: { maxAgeHours: 2 } }),
    ).toEqual({ ...DEV_POLICY, promptPresence: { maxAgeHours: 2 } });
  });

  it("keeps the base for a setting it cannot make sense of, and for a file that is not JSON", async () => {
    const file = join(dir, "broken.json");
    await writeFile(
      file,
      JSON.stringify({
        deviceApproval: "sometimes",
        answers: 3,
        promptPresence: { maxAgeHours: -1 },
      }),
    );
    expect(await loadPolicy(file, DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    await writeFile(file, "{not json");
    expect(await loadPolicy(file, DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });
});
