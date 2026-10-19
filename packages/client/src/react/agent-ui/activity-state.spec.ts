import type { AgentActivity } from "@parlor/agent-ui/client";
import { describe, expect, it } from "vitest";

import { deriveActivityState } from "./activity-state.js";

const origin = { via: "mcp", name: "Claude Code" } as const;

const last = (outcome?: NonNullable<AgentActivity["last"]>["outcome"]) => ({
  op: "set" as const,
  origin,
  at: 1,
  outcome,
});

describe("deriveActivityState", () => {
  it("is idle before the agent has done anything", () => {
    expect(deriveActivityState({ busy: false, last: undefined }, undefined)).toEqual({
      status: "idle",
    });
  });

  it("is busy with the running op and who asked while a request runs", () => {
    const running = last();
    expect(deriveActivityState({ busy: true, last: running }, undefined)).toEqual({
      status: "busy",
      op: "set",
      origin,
    });
  });

  it("is done once the request succeeded", () => {
    const finished = last({ status: "done" });
    expect(deriveActivityState({ busy: false, last: finished }, undefined)).toEqual({
      status: "done",
      op: "set",
      origin,
    });
  });

  it("is done for an op that has no outcome, such as an answered confirmation", () => {
    const answered = { op: "confirm" as const, origin, at: 1 };
    expect(deriveActivityState({ busy: false, last: answered }, undefined)).toEqual({
      status: "done",
      op: "confirm",
      origin,
    });
  });

  it("is refused with the code the agent got", () => {
    const refused = last({ status: "refused", code: "user_editing" });
    expect(deriveActivityState({ busy: false, last: refused }, undefined)).toEqual({
      status: "refused",
      op: "set",
      origin,
      code: "user_editing",
    });
  });

  it("is idle once the finished event has faded", () => {
    const finished = last({ status: "done" });
    expect(deriveActivityState({ busy: false, last: finished }, finished)).toEqual({
      status: "idle",
    });
  });

  it("shows an event that came after the faded one", () => {
    const faded = last({ status: "done" });
    const next = last({ status: "done" });
    expect(deriveActivityState({ busy: false, last: next }, faded)).toEqual({
      status: "done",
      op: "set",
      origin,
    });
  });

  it("is busy even when the running event is the one that faded", () => {
    const running = last();
    expect(deriveActivityState({ busy: true, last: running }, running)).toEqual({
      status: "busy",
      op: "set",
      origin,
    });
  });
});
