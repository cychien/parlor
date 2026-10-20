import { describe, expect, it } from "vitest";

import { chatItemBodies } from "./items.js";
import { isPromptTooLong, MAX_PROMPT_CHARS, PROMPT_LIMIT_MESSAGE } from "./limits.js";

const agent = { hostId: "host_mac", agentId: "claude" };
const promptOf = (text: string) => chatItemBodies.prompt.body.safeParse({ text, agent });

describe("prompt limit", () => {
  it("is 32,000 characters and the message names it", () => {
    expect(MAX_PROMPT_CHARS).toBe(32_000);
    expect(PROMPT_LIMIT_MESSAGE).toBe("Messages can be at most 32,000 characters.");
  });

  it("agrees with the schema the send action validates against", () => {
    expect(promptOf("x".repeat(32_000)).success).toBe(true);
    expect(isPromptTooLong("x".repeat(32_000))).toBe(false);
    expect(promptOf("x".repeat(32_001)).success).toBe(false);
    expect(isPromptTooLong("x".repeat(32_001))).toBe(true);
  });

  it("measures the text the client sends, which is trimmed", () => {
    expect(isPromptTooLong(`  ${"x".repeat(32_000)}\n`)).toBe(false);
  });
});
