import { describe, expect, it } from "vitest";

import { chatItemBodies } from "./items.js";
import {
  AGENT_OPTION_LIMITS,
  clipAgentOptions,
  isPromptTooLong,
  MAX_PROMPT_CHARS,
  PROMPT_LIMIT_MESSAGE,
} from "./limits.js";

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

describe("clipAgentOptions", () => {
  const option = (
    values: { id: string; name: string; description?: string }[],
    current = values[0]!.id,
  ) => ({
    id: "agent",
    name: "Agent",
    current,
    values,
  });

  it("cuts names and descriptions to their limits with an ellipsis, and keeps ids exact", () => {
    const [clipped] = clipAgentOptions([
      option([
        { id: "web-fetch", name: "n".repeat(300), description: "d".repeat(2_000) },
      ]),
    ]);
    const value = clipped!.values[0]!;
    expect(value.id).toBe("web-fetch");
    expect(value.name).toHaveLength(AGENT_OPTION_LIMITS.valueName);
    expect(value.description).toBe(`${"d".repeat(499)}…`);
  });

  it("keeps the first values and the current one among them", () => {
    const values = Array.from({ length: 80 }, (_, at) => ({
      id: `v${at}`,
      name: `v${at}`,
    }));
    const [clipped] = clipAgentOptions([option(values, "v70")]);
    expect(clipped!.values).toHaveLength(50);
    expect(clipped!.values.map((value) => value.id)).toEqual([
      ...values.slice(0, 49).map((value) => value.id),
      "v70",
    ]);
  });

  it("drops a value or an option whose id could not be sent back, and options past ten", () => {
    const long = "x".repeat(201);
    const [kept] = clipAgentOptions([
      option([
        { id: "ok", name: "ok" },
        { id: long, name: "too long" },
      ]),
    ]);
    expect(kept!.values.map((value) => value.id)).toEqual(["ok"]);
    expect(clipAgentOptions([{ ...option([{ id: "a", name: "a" }]), id: long }])).toEqual(
      [],
    );
    const many = Array.from({ length: 12 }, (_, at) => ({
      ...option([{ id: "a", name: "a" }]),
      id: `o${at}`,
    }));
    expect(clipAgentOptions(many)).toHaveLength(10);
  });
});
