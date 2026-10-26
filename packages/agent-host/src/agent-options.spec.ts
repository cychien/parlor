import { describe, expect, it } from "vitest";

import {
  agentUsageOf,
  codexUsageOf,
  mergeUsage,
  optionChanges,
} from "./agent-options.js";

const OPTIONS = [
  {
    id: "model",
    name: "Model",
    current: "default",
    values: [
      { id: "default", name: "Default" },
      { id: "sonnet", name: "Sonnet" },
    ],
  },
];

describe("the options a prompt may choose", () => {
  it("changes only what the agent offers and does not already run with", () => {
    expect(
      optionChanges(OPTIONS, {
        model: "sonnet",
        mode: "bypassPermissions",
        missing: "x",
      }),
    ).toEqual([{ id: "model", value: "sonnet" }]);
    expect(optionChanges(OPTIONS, { model: "default" })).toEqual([]);
    expect(optionChanges(OPTIONS, { model: "opus-but-not-offered" })).toEqual([]);
    expect(optionChanges(OPTIONS, undefined)).toEqual([]);
  });
});

describe("the account's allowance", () => {
  const AT = 1_800_000_000_000;

  it("reads Claude Code's rate limit off a usage update, account windows first", () => {
    expect(
      agentUsageOf(
        {
          "_claude/rateLimit": {
            unifiedWindows: {
              seven_day_opus: { utilization: 0.1 },
              seven_day: { utilization: 0.42, resetsAt: 1_800_100_000 },
              five_hour: { utilization: 1.4 },
              bogus: { utilization: 0.5 },
            },
          },
        },
        AT,
      ),
    ).toEqual({
      windows: [
        { id: "five_hour", minutes: 300, used: 1 },
        { id: "seven_day", minutes: 10_080, used: 0.42, resetsAt: 1_800_100_000_000 },
        { id: "seven_day_opus", minutes: 10_080, used: 0.1 },
      ],
      at: AT,
    });
    expect(
      agentUsageOf(
        { "_claude/rateLimit": { rateLimitType: "five_hour", utilization: 0.3 } },
        AT,
      ),
    ).toEqual({ windows: [{ id: "five_hour", minutes: 300, used: 0.3 }], at: AT });
  });

  it("reads Codex's rate limit off its app-server, each window by its own length", () => {
    expect(
      codexUsageOf(
        {
          rateLimits: {
            primary: {
              usedPercent: 12,
              windowDurationMins: 300,
              resetsAt: 1_800_000_100,
            },
            secondary: { usedPercent: 140, windowDurationMins: 10_080 },
            credits: { hasCredits: false },
            planType: "plus",
          },
        },
        AT,
      ),
    ).toEqual({
      windows: [
        { id: "primary", minutes: 300, used: 0.12, resetsAt: 1_800_000_100_000 },
        { id: "secondary", minutes: 10_080, used: 1 },
      ],
      at: AT,
    });
    expect(codexUsageOf(undefined, AT)).toBeUndefined();
    expect(
      codexUsageOf({ rateLimits: { primary: { usedPercent: 5 } } }, AT),
    ).toBeUndefined();
  });

  it("says nothing about an update that carries no rate limit", () => {
    expect(agentUsageOf(undefined, AT)).toBeUndefined();
    expect(
      agentUsageOf({ "_claude/rateLimit": { status: "allowed" } }, AT),
    ).toBeUndefined();
  });

  it("lays a report over the one held, window by window, dropping those that rolled over", () => {
    const held = {
      windows: [
        { id: "five_hour", minutes: 300, used: 0.9, resetsAt: AT - 1 },
        { id: "seven_day", minutes: 10_080, used: 0.2, resetsAt: AT + 1 },
        { id: "seven_day_opus", minutes: 10_080, used: 0.1 },
      ],
      at: AT - 10,
    };
    expect(
      mergeUsage(held, {
        windows: [{ id: "seven_day_opus", minutes: 10_080, used: 0.3 }],
        at: AT,
      }),
    ).toEqual({
      windows: [
        { id: "seven_day", minutes: 10_080, used: 0.2, resetsAt: AT + 1 },
        { id: "seven_day_opus", minutes: 10_080, used: 0.3 },
      ],
      at: AT,
    });
  });
});
