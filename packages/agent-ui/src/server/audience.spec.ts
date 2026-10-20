import { ANONYMOUS, asId, DEV_USER_ID, type Principal } from "@parlor/core";
import { describe, expect, it } from "vitest";

import { audienceOf } from "./audience.js";

const devHost: Principal = {
  kind: "host",
  userId: DEV_USER_ID,
  grantId: asId("grant", "dev"),
  hostId: asId("host", "dev"),
};

const devTurn: Principal = {
  kind: "agent",
  userId: DEV_USER_ID,
  grantId: asId("grant", "dev"),
  agent: { name: "Claude Code", verified: true },
  turn: {
    threadId: asId("thread", "t1"),
    turnId: asId("turn", "u1"),
    hostId: asId("host", "dev"),
    clientId: "tab-1",
  },
};

describe("audienceOf", () => {
  it("puts the dev host's principals in the anonymous browser's audience", () => {
    expect(audienceOf("default", ANONYMOUS)).toBe("default");
    expect(audienceOf("default", devHost)).toBe("default");
    expect(audienceOf("default", devTurn)).toBe("default");
  });

  it("names the user once a provider tells people apart", () => {
    const alice: Principal = {
      kind: "user",
      userId: asId("user", "alice"),
      sessionId: "s1",
    };
    expect(audienceOf("acme", alice)).toBe("acme\u001falice");
  });

  it("makes the dev user the scope's default user", () => {
    expect(DEV_USER_ID).toBe("default");
  });
});
