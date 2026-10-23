import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_UNAVAILABLE_WARNING,
  agentUnavailableInProduction,
  warnChatWithoutAuth,
} from "./chat-warning.js";

const HEAD = `import { chat } from "@parlor/chat/server";\nimport { createServer } from "@parlor/server";\n`;

async function projectWith(server: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "parlor-chat-warning-"));
  await writeFile(join(rootDir, "server.ts"), `${HEAD}${server}\n`);
  const config = parseConfig({ app: { id: "com.example.todo", name: "Todo" } });
  return { config, rootDir, configFile: join(rootDir, "parlor.config.ts") };
}

describe("the production warning for chat without sign-in (G1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires only when chat is installed and auth is absent", () => {
    expect(agentUnavailableInProduction({ chat: "installed", auth: "absent" })).toBe(
      true,
    );
    for (const auth of ["installed", "unknown"] as const) {
      expect(agentUnavailableInProduction({ chat: "installed", auth })).toBe(false);
    }
    for (const chat of ["absent", "unknown"] as const) {
      expect(agentUnavailableInProduction({ chat, auth: "absent" })).toBe(false);
    }
  });

  it.each([
    [
      "the default template",
      "export default createServer({ actions, plugins: [chat()] });",
      1,
    ],
    [
      "an app with sign-in",
      "export default createServer({ actions, plugins: [chat()], auth: createAuth() });",
      0,
    ],
    [
      "a conditional auth",
      "export default createServer({ actions, plugins: [chat()], auth: prod ? a : undefined });",
      0,
    ],
    ["an app without chat", "export default createServer({ actions });", 0],
  ])("warns %s that many times", async (_name, server, times) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await warnChatWithoutAuth(await projectWith(server));
    expect(warn.mock.calls).toEqual(
      Array.from({ length: times }, () => [AGENT_UNAVAILABLE_WARNING]),
    );
  });
});
